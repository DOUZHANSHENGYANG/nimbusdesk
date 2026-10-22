//! CLI 发现内核（只读）。
//!
//! 设计约束（重要）：
//! - **只读**：本模块只读取目录、配置文件与环境变量，绝不写入任何东西。
//!   扫描可以放心高频调用，不会破坏用户环境。
//! - **三个来源**：包管理器全局包、`PATH` 可执行文件、已知安装根目录。
//!   三者互不依赖，任何一个不可用都不影响其它来源。
//! - **程序白名单**：所有子进程调用只走 [`run_whitelisted`]，程序名必须来自
//!   [`SCAN_WHITELIST`] 且参数在代码里写死；用户输入永远不会变成程序名或参数。
//! - **超时**：每次子进程调用都带超时，超时只把该来源标记为「未响应」，
//!   不阻塞其它来源的结果。
//!
//! 关于「探测任意 CLI」与白名单的关系：用途解释需要执行被发现的工具本身
//! （`--version` / `--help`）。这条路径由 [`run_probe`] 承担，约束更严：
//! 程序必须来自本次扫描结果（不是用户输入），参数只能是两个固定标志之一，
//! 且同样带短超时。

use crate::ahub::models::{CliScanReport, DiscoveredCli, ScanSource};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// 扫描命令允许执行的程序白名单。参数由调用点写死，不接受外部输入。
pub const SCAN_WHITELIST: &[&str] = &["npm", "pnpm", "python", "py", "pip", "cargo", "choco"];

/// 用途探测允许的标志。固定两个，不接受任意参数。
pub const PROBE_FLAGS: &[&str] = &["--version", "--help"];

/// 扫描类子进程的默认超时。
///
/// 实测本机 `npm ls -g --depth=0 --json` 冷启动约 8 秒，10 秒预算余量不足会误判
/// 「未响应」。因此取 30 秒，并允许用 `AGENTHUB_SCAN_TIMEOUT_SECS` 覆盖。
pub fn scan_timeout() -> Duration {
    std::env::var("AGENTHUB_SCAN_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or(Duration::from_secs(30))
}

/// 用途探测的短超时（`--help` 有挂起风险，必须比扫描更短）。
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// 一次子进程调用的结果。
#[derive(Debug, Clone, Default)]
pub struct CommandOutput {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

impl CommandOutput {
    /// 合并 stdout 与 stderr 的非空行，便于从 `--version` 里找版本号。
    pub fn merged_lines(&self) -> Vec<String> {
        self.stdout
            .lines()
            .chain(self.stderr.lines())
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    }
}

// ---------------- 程序解析与执行 ----------------

/// `PATHEXT` 拆出的可执行扩展名（Windows 默认 `.COM;.EXE;.BAT;.CMD`）。
fn path_exts() -> Vec<String> {
    let raw = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let mut out: Vec<String> = raw
        .split(';')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if out.is_empty() {
        out = vec![".COM".into(), ".EXE".into(), ".BAT".into(), ".CMD".into()];
    }
    out
}

/// 判断一个无扩展名文件是否是 shell 脚本（`#!/bin/sh` 开头）。
///
/// 这类文件在 Windows 上无法直接 CreateProcess 启动，必须排除。
fn looks_like_shell_script(path: &Path) -> bool {
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = [0u8; 2];
    match f.read(&mut head) {
        Ok(2) => head == [b'#', b'!'],
        _ => false,
    }
}

/// 把一个裸命令名解析成真实可执行文件路径。
///
/// Windows 上 npm/git 等是 `.cmd` 批处理，`Command::new("npm")` 会直接
/// "program not found"，所以必须先按 `PATHEXT` 补齐扩展名再执行。
///
/// 关键细节：Node 的 Windows 安装目录里同时存在 `npm`（无扩展名、Git Bash 用的
/// shell 脚本）和 `npm.cmd`。若先命中无扩展名的那个，启动会失败并报
/// "不是有效的 Win32 应用程序 (os error 193)"。因此**必须先试带扩展名的候选**，
/// 无扩展名的裸文件只在完全没有扩展名候选时才考虑，且跳过明显的 shell 脚本。
///
/// **安全约束**：本函数只接受「裸命令名」。含路径分隔符、`..`、或盘符的输入一律
/// 拒绝，即使该文件真实存在。原因是 `name` 可能来自前端 IPC；若允许它携带路径，
/// 任意可执行文件都会变成执行入口，绕过白名单。需要执行已知路径时，走
/// [`is_probe_allowed`] 校验后的显式路径分支。
pub fn resolve_program(name: &str) -> Option<PathBuf> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    // 只接受裸命令名：拒绝任何路径成分
    if name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains(':')
        || name.contains('\0')
    {
        return None;
    }

    let exts = path_exts();
    let mut dirs: Vec<PathBuf> = std::env::var("PATH")
        .unwrap_or_default()
        .split(';')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect();
    // 已知根目录也参与解析：有些工具装了但没进 PATH
    dirs.extend(known_roots());

    // 第一轮：只找带可执行扩展名的
    for dir in &dirs {
        for ext in &exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // 第二轮：无扩展名的裸文件，但要排除 shell 脚本（Git Bash / MSYS 用的那种）
    for dir in &dirs {
        let base = dir.join(name);
        if base.is_file() && !looks_like_shell_script(&base) {
            return Some(base);
        }
    }
    None
}

/// 执行一个子进程，带超时与输出收集。
///
/// 用独立线程读取 stdout/stderr，避免子进程输出超过管道缓冲时双方互等死锁。
///
/// **关键细节（踩过的坑）**：超时后 `child.kill()` 只杀掉直接子进程。`npm.cmd`
/// 这类批处理会再拉起 `node.exe` 子进程，孙子进程仍持有管道写端，于是读线程里的
/// `read_to_string` 永远不返回，`join()` 就会永久阻塞——整个扫描挂死、界面永远停在
/// 「扫描中…」。因此超时路径**不能阻塞等待读线程**：改用 `mpsc` + 超时轮询拿已读到的
/// 内容，读线程留在后台自行结束。
pub fn run_command(program: &Path, args: &[&str], timeout: Duration) -> Result<CommandOutput, String> {
    let mut cmd = crate::ahub::store::silent_command(&program.to_string_lossy());
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 {}：{e}", program.display()))?;

    let mut out_pipe = child.stdout.take().ok_or("无法读取子进程 stdout")?;
    let mut err_pipe = child.stderr.take().ok_or("无法读取子进程 stderr")?;

    let (out_tx, out_rx) = std::sync::mpsc::channel::<String>();
    let (err_tx, err_rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out_pipe.read_to_string(&mut s);
        let _ = out_tx.send(s);
    });
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err_pipe.read_to_string(&mut s);
        let _ = err_tx.send(s);
    });

    /// 收集已读到的内容；读线程未结束时返回已收到的部分（不阻塞）。
    fn drain(rx: &std::sync::mpsc::Receiver<String>) -> String {
        match rx.try_recv() {
            Ok(s) => s,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => String::new(),
            Err(std::sync::mpsc::TryRecvError::Empty) => String::new(),
        }
    }

    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // 正常退出：给读线程一点时间把剩余内容送过来
                let deadline = Instant::now() + Duration::from_millis(500);
                let mut stdout = String::new();
                let mut stderr = String::new();
                loop {
                    if stdout.is_empty() {
                        if let Ok(s) = out_rx.try_recv() {
                            stdout = s;
                        }
                    }
                    if stderr.is_empty() {
                        if let Ok(s) = err_rx.try_recv() {
                            stderr = s;
                        }
                    }
                    if !stdout.is_empty() && !stderr.is_empty() {
                        break;
                    }
                    if Instant::now() >= deadline {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                return Ok(CommandOutput {
                    ok: status.success(),
                    stdout,
                    stderr,
                    timed_out: false,
                });
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    // 只取已经读到的内容，绝不 join 读线程：孙子进程可能仍持有管道
                    return Ok(CommandOutput {
                        ok: false,
                        stdout: drain(&out_rx),
                        stderr: drain(&err_rx),
                        timed_out: true,
                    });
                }
                std::thread::sleep(Duration::from_millis(30));
            }
            Err(e) => return Err(format!("等待 {} 失败：{e}", program.display())),
        }
    }
}

/// 白名单内的扫描调用。程序名必须命中 [`SCAN_WHITELIST`]。
pub fn run_whitelisted(name: &str, args: &[&str], timeout: Duration) -> Result<CommandOutput, String> {
    if !SCAN_WHITELIST.contains(&name) {
        return Err(format!("程序 {name} 不在扫描白名单内，已拒绝执行"));
    }
    let path = resolve_program(name).ok_or_else(|| format!("找不到程序：{name}"))?;
    run_command(&path, args, timeout)
}

/// 用途探测：只允许本次扫描发现的工具，且参数只能是固定标志之一。
pub fn run_probe(program: &Path, flag: &str, timeout: Duration) -> Result<CommandOutput, String> {
    if !PROBE_FLAGS.contains(&flag) {
        return Err(format!("探测标志 {flag} 不在允许范围内，已拒绝执行"));
    }
    run_command(program, &[flag], timeout)
}

/// 判断一个可执行路径是否位于允许探测的位置。
///
/// **安全约束**：`install_path` 由前端 IPC 传入，属于外部输入。若直接把它当程序
/// 执行，攻击面就是「任意可执行文件 + 两个固定标志」，绕过白名单的意图。
/// 因此这里要求路径必须落在 `PATH` 的某个目录、或已知安装根目录之内。
/// 这样既保留了「探测已安装工具」的能力，又不会把任意路径变成执行入口。
pub fn is_probe_allowed(program: &Path) -> bool {
    let Ok(canonical) = program.canonicalize() else {
        return false;
    };
    if !canonical.is_file() {
        return false;
    }
    let mut roots: Vec<PathBuf> = std::env::var("PATH")
        .unwrap_or_default()
        .split(';')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect();
    roots.extend(known_roots());

    for root in roots {
        let Ok(root_canon) = root.canonicalize() else {
            continue;
        };
        if canonical.starts_with(&root_canon) {
            return true;
        }
    }
    false
}

/// 解析一个「可用于探测」的程序路径。
///
/// 前端传来的路径只有在通过 [`is_probe_allowed`] 时才采用；否则退回按命令名
/// 在 PATH / 已知根目录中解析。两者都失败时返回 `None`，由调用方走「无法探测」分支。
pub fn resolve_probe_target(name: &str, install_path: &str) -> Option<PathBuf> {
    if !install_path.trim().is_empty() {
        let candidate = PathBuf::from(install_path.trim());
        if is_probe_allowed(&candidate) {
            return Some(candidate);
        }
    }
    resolve_program(name)
}

// ---------------- 分类 ----------------

/// 按命令名归类。无法归类时返回 `other`，而不是丢弃该工具。
pub fn categorize(name: &str) -> &'static str {
    const VERSION_CONTROL: &[&str] = &["git", "svn", "hg", "git-lfs", "glab", "gh", "lazygit", "delta"];
    const LANGUAGE: &[&str] = &[
        "node", "deno", "bun", "python", "python3", "py", "rustc", "go", "java", "javac", "dotnet",
        "php", "ruby", "perl", "lua", "dart", "flutter", "tsc", "kotlin", "swift", "zig",
    ];
    const PACKAGE_MANAGER: &[&str] = &[
        "npm", "pnpm", "yarn", "pip", "pip3", "cargo", "choco", "scoop", "winget", "brew", "gem",
        "composer", "vcpkg", "conda", "mamba", "uv", "poetry", "npx", "pipx", "corepack",
    ];
    const CONTAINER: &[&str] = &[
        "docker", "podman", "kubectl", "helm", "minikube", "kind", "nerdctl", "k3d", "ctr",
    ];
    const BUILD: &[&str] = &[
        "cmake", "make", "ninja", "gradle", "mvn", "msbuild", "vite", "webpack", "esbuild",
        "meson", "bazel", "gcc", "g++", "clang", "ld", "pkg-config",
    ];
    const CLOUD: &[&str] = &[
        "aws", "az", "gcloud", "gsutil", "terraform", "pulumi", "wrangler", "vercel", "netlify",
        "flyctl", "heroku", "doctl", "railway", "supabase",
    ];
    const AI_AGENT: &[&str] = &[
        "claude", "codex", "gemini", "opencode", "codebuddy", "pi", "dsh", "cursor", "copilot",
        "ollama", "llm", "aichat", "crush", "aider", "qwen", "comet", "workbuddy",
    ];
    const PRODUCTIVITY: &[&str] = &[
        "rg", "fd", "fzf", "bat", "jq", "yq", "curl", "wget", "7z", "ffmpeg", "tmux", "nvim",
        "vim", "code", "starship", "zoxide", "eza", "exa", "tree", "http", "hyperfine", "sd",
        "less", "more", "tar", "ssh", "scp", "openssl",
    ];

    let n = name.to_ascii_lowercase();
    let n = n.trim_end_matches(".exe").trim_end_matches(".cmd").trim_end_matches(".bat");
    let has = |set: &[&str]| set.contains(&n);
    if has(VERSION_CONTROL) {
        "version-control"
    } else if has(LANGUAGE) {
        "language"
    } else if has(PACKAGE_MANAGER) {
        "package-manager"
    } else if has(CONTAINER) {
        "container"
    } else if has(BUILD) {
        "build"
    } else if has(CLOUD) {
        "cloud"
    } else if has(AI_AGENT) {
        "ai-agent"
    } else if has(PRODUCTIVITY) {
        "productivity"
    } else {
        "other"
    }
}

// ---------------- 已知安装根目录 ----------------

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// 除 `PATH` 之外还要补扫的常见安装根目录。
///
/// 目的是解决「装了但没进 PATH」导致界面看不见的问题。
pub fn known_roots() -> Vec<PathBuf> {
    let h = home();
    let mut out = vec![
        h.join(".local").join("bin"),
        h.join(".cargo").join("bin"),
        h.join(".bun").join("bin"),
        h.join(".deno").join("bin"),
        h.join("go").join("bin"),
        h.join(".volta").join("bin"),
        h.join("scoop").join("shims"),
    ];
    if let Some(cargo_home) = env_path("CARGO_HOME") {
        out.push(cargo_home.join("bin"));
    }
    if let Some(appdata) = env_path("APPDATA") {
        out.push(PathBuf::from(&appdata).join("npm"));
    }
    if let Some(local) = env_path("LOCALAPPDATA") {
        let local = PathBuf::from(&local);
        out.push(local.join("pnpm"));
    }
    out
}

/// 判断一个 PATH 目录是否应当跳过。
///
/// 用户要看的是「装了什么工具」，而不是操作系统内部实现。放进来的后果是
/// 清单里 1291 条有 668 条来自 `system32`（`agentactivationruntimestarter.exe`
/// 这类），真正有用的工具被淹没。因此排除三类目录：
/// 1. Windows 系统目录（system32 / SysWOW64 / WinSxS / Windows 根等）；
/// 2. `WindowsApps`：里面是应用执行别名（reparse 点），不是真实程序；
/// 3. 构建产物目录（`target/debug`、`target/release`）：是编译输出不是安装的工具。
pub(crate) fn skip_path_dir(dir: &Path) -> bool {
    let lower = dir.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    if lower.contains("\\windows\\system32")
        || lower.contains("\\windows\\syswow64")
        || lower.contains("\\windows\\winsxs")
        || lower.contains("\\windows\\systemapps")
        || lower.ends_with("\\windows")
    {
        return true;
    }
    if lower.contains("\\microsoft\\windowsapps") {
        return true;
    }
    // 构建产物：target/debug、target/release 及其 deps 子目录
    // （deps 里全是测试二进制，如 agenthub-1fdfad7069a1aeb3.exe）
    if lower.contains("\\target\\debug") || lower.contains("\\target\\release") {
        return true;
    }
    false
}

/// 判断一个 PATH 目录是否是「SDK 附带工具目录」。///
/// 这类目录一次能贡献几十上百个程序（Qt 的 `mingw_64/bin`、JDK 的 `bin`、
/// Python 的 `Scripts`），其中绝大多数是编译器内部件与辅助小工具，不是用户
/// 主动安装、会单独使用的 CLI。它们混进清单只会让「有哪些工具」这个核心问题
/// 更难回答。这里的做法是：**降低它们的可见度**而不是完全丢弃——仍然扫描，
/// 但标记为「随 SDK 附带」，前端默认折叠。
fn is_sdk_bundled_dir(dir: &Path) -> bool {
    let lower = dir.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    // Qt 工具链
    if lower.contains("\\qt\\") || lower.contains("\\qtcreator") {
        return true;
    }
    // JDK / JRE
    if lower.contains("\\jdk") || lower.contains("\\jre") || lower.contains("\\java\\") {
        return true;
    }
    // Python 的 Scripts：里面是 pip 安装的 console_scripts，数量大但多是库附带
    if lower.contains("\\python") && lower.ends_with("\\scripts") {
        return true;
    }
    // Flutter / Dart 的 SDK 内部
    if lower.contains("\\flutter\\bin") || lower.contains("\\dart-sdk") {
        return true;
    }
    // MinGW / MSYS
    if lower.contains("\\mingw") || lower.contains("\\msys") || lower.contains("\\cygwin") {
        return true;
    }
    false
}

// ---------------- 来源一：包管理器 ----------------

/// 一个来源的扫描结果。
struct SourceResult {
    tools: Vec<DiscoveredCli>,
    note: String,
    ok: bool,
}

impl SourceResult {
    fn failed(note: impl Into<String>) -> Self {
        Self {
            tools: Vec::new(),
            note: note.into(),
            ok: false,
        }
    }
}

fn make_cli(name: &str, source: &str, detail: &str, path: &str, version: &str) -> DiscoveredCli {
    DiscoveredCli {
        name: name.to_string(),
        source: source.to_string(),
        source_detail: detail.to_string(),
        install_path: path.to_string(),
        version: version.to_string(),
        category: categorize(name).to_string(),
        installed: true,
    }
}

/// 读 npm 全局包的 `bin` 字段，得到真实命令名。
///
/// 包名末段不等于命令名：`@opencode/cli` 的命令是 `opencode`，
/// `@rpamis/comet` 的命令是 `comet`。用包名末段会把前者显示成 `cli`，
/// 用户根本认不出这是什么工具。因此优先读 package.json 的 `bin`。
fn npm_bin_names(install_root: &Path, pkg: &str) -> Vec<String> {
    let pkg_json = install_root.join(pkg).join("package.json");
    let Ok(text) = std::fs::read_to_string(&pkg_json) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let Some(bin) = v.get("bin") else { return Vec::new() };
    let mut out = Vec::new();
    match bin {
        // "bin": { "opencode": "./bin/opencode.exe", "opencode2": "…" }
        serde_json::Value::Object(map) => {
            for key in map.keys() {
                out.push(key.clone());
            }
        }
        // "bin": "./bin/x.js" → 命令名等于包名末段
        serde_json::Value::String(_) => {
            if let Some(seg) = pkg.rsplit('/').next() {
                out.push(seg.to_string());
            }
        }
        _ => {}
    }
    out
}

fn scan_npm() -> SourceResult {
    let out = match run_whitelisted("npm", &["list", "-g", "--depth=0", "--json"], scan_timeout()) {
        Ok(o) => o,
        Err(e) => return SourceResult::failed(e),
    };
    if out.timed_out {
        return SourceResult::failed("npm 列表命令超时（未响应）");
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&out.stdout) else {
        return SourceResult::failed("npm 返回的内容无法解析为 JSON");
    };
    // 全局安装根目录：用于展示安装路径与读取 bin 字段；失败不影响列表
    let root = run_whitelisted("npm", &["root", "-g"], scan_timeout())
        .ok()
        .filter(|o| o.ok && !o.timed_out)
        .map(|o| o.stdout.trim().to_string())
        .unwrap_or_default();
    let root_path = if root.is_empty() {
        None
    } else {
        Some(PathBuf::from(&root))
    };

    let mut tools = Vec::new();
    if let Some(deps) = v.get("dependencies").and_then(|d| d.as_object()) {
        for (pkg, info) in deps {
            let version = info.get("version").and_then(|x| x.as_str()).unwrap_or("");
            let path = root_path
                .as_ref()
                .map(|r| r.join(pkg).to_string_lossy().into_owned())
                .unwrap_or_default();

            // 优先用 package.json 的 bin 命令名；读不到才退回包名末段
            let names = match &root_path {
                Some(r) => npm_bin_names(r, pkg),
                None => Vec::new(),
            };
            if names.is_empty() {
                let bin = pkg.rsplit('/').next().unwrap_or(pkg);
                tools.push(make_cli(bin, "package-manager", "npm", &path, version));
            } else {
                for bin in names {
                    tools.push(make_cli(&bin, "package-manager", "npm", &path, version));
                }
            }
        }
    }
    SourceResult {
        note: if tools.is_empty() {
            "npm 全局没有已安装的包".into()
        } else {
            String::new()
        },
        ok: true,
        tools,
    }
}

fn scan_pnpm() -> SourceResult {
    let out = match run_whitelisted("pnpm", &["list", "-g", "--depth=0", "--json"], scan_timeout()) {
        Ok(o) => o,
        Err(e) => return SourceResult::failed(e),
    };
    if out.timed_out {
        return SourceResult::failed("pnpm 列表命令超时（未响应）");
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&out.stdout) else {
        return SourceResult::failed("pnpm 返回的内容无法解析为 JSON");
    };
    // pnpm 在不同版本下可能给对象或数组，两种都接
    let entries: Vec<&serde_json::Value> = match &v {
        serde_json::Value::Array(a) => a.iter().collect(),
        other => vec![other],
    };
    let mut tools = Vec::new();
    for entry in entries {
        let base = entry.get("path").and_then(|x| x.as_str()).unwrap_or("");
        if let Some(deps) = entry.get("dependencies").and_then(|d| d.as_object()) {
            for (pkg, info) in deps {
                let version = info.get("version").and_then(|x| x.as_str()).unwrap_or("");
                let bin = pkg.rsplit('/').next().unwrap_or(pkg);
                let path = if base.is_empty() {
                    String::new()
                } else {
                    PathBuf::from(base).join(pkg).to_string_lossy().into_owned()
                };
                tools.push(make_cli(bin, "package-manager", "pnpm", &path, version));
            }
        }
    }
    SourceResult {
        note: if tools.is_empty() {
            "pnpm 全局没有已安装的包".into()
        } else {
            String::new()
        },
        ok: true,
        tools,
    }
}

/// pip 的 site-packages 目录（用于判断包是否带 CLI 入口）。
///
/// 不能用 `site.getsitepackages()[0]`：在部分发行版上它返回的是安装根目录
/// （`D:\03-SDK\Python313`），而不是 `…\Lib\site-packages`。这里优先取
/// `sysconfig` 的 `purelib`/`platlib`。
fn pip_site_packages() -> Option<PathBuf> {
    let script = "import sysconfig;\
print(sysconfig.get_paths().get('purelib',''));\
print(sysconfig.get_paths().get('platlib',''))";
    let out = run_whitelisted("python", &["-c", script], scan_timeout()).ok()?;
    if out.timed_out {
        return None;
    }
    for line in out.stdout.lines() {
        let p = PathBuf::from(line.trim());
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

/// site-packages 的 CLI 入口索引。
///
/// 逐个包 `read_dir` 整个 site-packages 是 O(包数 × 目录项数) 的，实测 264 个包
/// 会拖到几十秒。这里一次遍历建立索引，后续判断变成 O(1) 查表。
#[derive(Debug, Default)]
struct PipCliIndex {
    /// 带 console_scripts / gui_scripts 的包（规范化为小写、`-` → `_`）
    with_scripts: std::collections::HashSet<String>,
    /// 带 `__main__.py` 的包目录
    with_main: std::collections::HashSet<String>,
}

impl PipCliIndex {
    fn build(site_packages: &Path) -> Self {
        let mut index = PipCliIndex::default();
        let Ok(entries) = std::fs::read_dir(site_packages) else {
            return index;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let fname = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let lower = fname.to_ascii_lowercase();

            if lower.ends_with(".dist-info") {
                let stem = lower.trim_end_matches(".dist-info").to_string();
                let stem_norm = stem.replace('-', "_");
                if let Ok(text) = std::fs::read_to_string(path.join("entry_points.txt")) {
                    if text.contains("[console_scripts]") || text.contains("[gui_scripts]") {
                        // dist-info 名是 <pkg>-<version>：去掉版本段
                        let pkg = stem_norm
                            .rsplit_once('_')
                            .map(|(head, _)| head.to_string())
                            .unwrap_or(stem_norm.clone());
                        index.with_scripts.insert(pkg);
                        index.with_scripts.insert(stem_norm);
                    }
                }
                continue;
            }

            if path.is_dir() && path.join("__main__.py").is_file() {
                index.with_main.insert(lower);
            }
        }
        index
    }

    fn has_cli(&self, pkg_name: &str) -> bool {
        let norm = pkg_name.to_ascii_lowercase().replace('-', "_");
        self.with_scripts.contains(&norm) || self.with_main.contains(&norm)
    }
}

fn scan_pip() -> SourceResult {
    let out = match run_whitelisted("python", &["-m", "pip", "list", "--format=json"], scan_timeout()) {
        Ok(o) => o,
        Err(e) => return SourceResult::failed(e),
    };
    if out.timed_out {
        return SourceResult::failed("pip 列表命令超时（未响应）");
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&out.stdout) else {
        return SourceResult::failed("pip 返回的内容无法解析为 JSON");
    };

    // 没有 site-packages 路径就无法判断 CLI 入口，此时退化为「全部列出」，
    // 宁可多列也不该整段缺失。
    let site = pip_site_packages();
    let index = site.as_ref().map(|p| PipCliIndex::build(p));
    let mut tools = Vec::new();
    let mut skipped = 0usize;
    if let Some(arr) = v.as_array() {
        for item in arr {
            let name = item.get("name").and_then(|x| x.as_str()).unwrap_or("");
            let version = item.get("version").and_then(|x| x.as_str()).unwrap_or("");
            if name.is_empty() {
                continue;
            }
            if let Some(index) = &index {
                if !index.has_cli(name) {
                    skipped += 1;
                    continue;
                }
            }
            tools.push(make_cli(name, "package-manager", "pip", "", version));
        }
    }
    SourceResult {
        note: if tools.is_empty() {
            "pip 没有提供命令行入口的包".into()
        } else if skipped > 0 {
            format!("已过滤 {skipped} 个纯库（不提供命令行入口）")
        } else {
            String::new()
        },
        ok: true,
        tools,
    }
}

/// Cargo 的已安装二进制清单：直接读 `.crates2.json`，零子进程。
fn scan_cargo() -> SourceResult {
    let cargo_home = env_path("CARGO_HOME").unwrap_or_else(|| home().join(".cargo"));
    let manifest = cargo_home.join(".crates2.json");
    let text = match std::fs::read_to_string(&manifest) {
        Ok(t) => t,
        Err(_) => {
            return SourceResult::failed(format!(
                "未找到 {}（未安装 cargo 或没有全局安装的二进制）",
                manifest.display()
            ))
        }
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return SourceResult::failed(".crates2.json 内容无法解析");
    };
    let mut tools = Vec::new();
    if let Some(installs) = v.get("installs").and_then(|x| x.as_object()) {
        // 结构：{ "包名 版本 (源)": { "bins": ["bin.exe", …], … } }
        for (key, info) in installs {
            let mut parts = key.split_whitespace();
            let _pkg = parts.next().unwrap_or("");
            let version = parts.next().unwrap_or("");
            let Some(bins) = info.get("bins").and_then(|b| b.as_array()) else {
                continue;
            };
            for bin in bins {
                let Some(bin) = bin.as_str() else { continue };
                let stem = Path::new(bin)
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| bin.to_string());
                // cargo-tauri 这类是子命令形式，展示时去掉 cargo- 前缀更贴近用户认知
                let display = stem.strip_prefix("cargo-").unwrap_or(&stem).to_string();
                let path = cargo_home.join("bin").join(bin);
                tools.push(make_cli(
                    &display,
                    "package-manager",
                    "cargo",
                    &path.to_string_lossy(),
                    version,
                ));
            }
        }
    }
    SourceResult {
        note: if tools.is_empty() {
            "cargo 没有全局安装的二进制".into()
        } else {
            String::new()
        },
        ok: true,
        tools,
    }
}

/// Chocolatey：**只读展示**。本工具不提供任何基于 choco 的写操作。
fn scan_choco() -> SourceResult {
    let out = match run_whitelisted(
        "choco",
        &["list", "--local-only", "--limit-output"],
        scan_timeout(),
    ) {
        Ok(o) => o,
        Err(e) => return SourceResult::failed(e),
    };
    if out.timed_out {
        return SourceResult::failed("choco 列表命令超时（未响应）");
    }
    let mut tools = Vec::new();
    for line in out.stdout.lines() {
        let line = line.trim();
        // 新版 choco 会先打印 "Chocolatey v…" 之类，只取 "name|version" 形式
        let Some((name, version)) = line.split_once('|') else {
            continue;
        };
        let name = name.trim();
        let version = version.trim();
        if name.is_empty() || !version.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            continue;
        }
        tools.push(make_cli(name, "package-manager", "choco", "", version));
    }
    SourceResult {
        note: if tools.is_empty() {
            "choco 没有已安装的包（本工具只展示，不提供迁移）".into()
        } else {
            "只读展示，不提供迁移".into()
        },
        ok: true,
        tools,
    }
}

// ---------------- 来源二 / 三：目录遍历 ----------------

fn is_executable_name(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(ext.to_ascii_lowercase().as_str(), "exe" | "cmd" | "bat")
}

/// 枚举一个目录下的可执行文件（.exe/.cmd/.bat）。cliscan 与 diskscan 共用。
pub(crate) fn scan_dir(dir: &Path, source: &str, detail: &str, out: &mut Vec<DiscoveredCli>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    // SDK 附带目录里的程序标上后缀，前端据此默认折叠
    let detail_label = if is_sdk_bundled_dir(dir) {
        format!("{detail}|sdk")
    } else {
        detail.to_string()
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_executable_name(&path) {
            continue;
        }
        let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
            continue;
        };
        out.push(make_cli(&stem, source, &detail_label, &path.to_string_lossy(), ""));
    }
}

fn scan_path_dirs() -> SourceResult {
    let raw = std::env::var("PATH").unwrap_or_default();
    let mut tools = Vec::new();
    let mut dirs = 0usize;
    let mut skipped = 0usize;
    for dir in raw.split(';').map(str::trim).filter(|s| !s.is_empty()) {
        let p = Path::new(dir);
        if !p.is_dir() {
            continue;
        }
        if skip_path_dir(p) {
            skipped += 1;
            continue;
        }
        dirs += 1;
        scan_dir(p, "path", "PATH", &mut tools);
    }
    SourceResult {
        ok: dirs > 0,
        note: if dirs == 0 {
            "PATH 中没有可读目录".into()
        } else if skipped > 0 {
            format!("遍历了 {dirs} 个 PATH 目录（已跳过 {skipped} 个系统/别名目录）")
        } else {
            format!("遍历了 {dirs} 个 PATH 目录")
        },
        tools,
    }
}

fn scan_known_dirs() -> SourceResult {
    let mut tools = Vec::new();
    let mut hits = 0usize;
    for root in known_roots() {
        if !root.is_dir() || skip_path_dir(&root) {
            continue;
        }
        hits += 1;
        let label = root.to_string_lossy().into_owned();
        scan_dir(&root, "known-root", &label, &mut tools);
    }
    SourceResult {
        ok: hits > 0,
        note: if hits == 0 {
            "没有找到已知安装根目录".into()
        } else {
            format!("补扫了 {hits} 个已知根目录")
        },
        tools,
    }
}

// ---------------- 汇总 ----------------

/// 来源优先级：数字越小越「具体」。同名工具去重时保留更具体的那条。
///
/// PATH 比已知根目录更具体：`where python` 的结果就是 PATH 顺序，
/// 用户期望看到的是实际会被执行的那个（Python313），而不是 WindowsApps 里的
/// 同名占位程序。所以 PATH 必须排在 known-root 前面。
fn source_rank(source: &str) -> u8 {
    match source {
        "package-manager" => 0,
        "path" => 1,
        _ => 2,
    }
}

fn merge(into: &mut BTreeMap<String, DiscoveredCli>, items: Vec<DiscoveredCli>) {
    for cli in items {
        let key = cli.name.to_ascii_lowercase();
        match into.get(&key) {
            None => {
                into.insert(key, cli);
            }
            Some(existing) => {
                // 更具体的来源（如包管理器）胜出，但胜出的一方可以继承
                // 泛来源（如 PATH）才有的安装路径与版本，避免信息丢失。
                if source_rank(&cli.source) < source_rank(&existing.source) {
                    let mut winner = cli;
                    if winner.version.is_empty() {
                        winner.version = existing.version.clone();
                    }
                    if winner.install_path.is_empty() {
                        winner.install_path = existing.install_path.clone();
                    }
                    into.insert(key, winner);
                } else if let Some(slot) = into.get_mut(&key) {
                    if slot.version.is_empty() {
                        slot.version = cli.version;
                    }
                    if slot.install_path.is_empty() {
                        slot.install_path = cli.install_path;
                    }
                }
            }
        }
    }
}

/// 并发执行各来源的扫描。
///
/// 各来源互不依赖，串行执行会让总耗时等于最慢那条命令的数倍（实测 npm 单条
/// 就要 8 秒）。这里每个来源一个线程，最后按固定顺序收集结果，保证输出稳定。
fn run_sources() -> Vec<(&'static str, &'static str, SourceResult)> {
    type Job = (&'static str, &'static str, fn() -> SourceResult);
    let jobs: Vec<Job> = vec![
        ("npm", "npm 全局包", scan_npm),
        ("pnpm", "pnpm 全局包", scan_pnpm),
        ("pip", "pip 包", scan_pip),
        ("cargo", "Cargo 二进制", scan_cargo),
        ("choco", "Chocolatey 包", scan_choco),
        ("path", "PATH 可执行文件", scan_path_dirs),
        ("known-root", "已知安装根目录", scan_known_dirs),
    ];

    let handles: Vec<_> = jobs
        .into_iter()
        .map(|(id, label, f)| std::thread::spawn(move || (id, label, f())))
        .collect();

    handles
        .into_iter()
        .filter_map(|h| h.join().ok())
        .collect()
}

/// 一份「常见 CLI 参考清单」：扫描没发现时，以「未安装」状态补进清单。
///
/// 为什么需要它：验收要求清单能看出「已安装 / 未安装」状态。若只列扫描结果，
/// 未安装的工具根本不会出现，用户无从得知「这个工具我可以装」。这里给出一份
/// 精选的常用工具，只补未出现的那些，且 `installed=false`，前端以灰色呈现。
///
/// 只列真正广泛使用的工具，避免变成一张冗长的清单。
const REFERENCE_CLIS: &[(&str, &str)] = &[
    // 版本控制
    ("git", "Git"),
    ("gh", "GitHub CLI"),
    // 语言运行时
    ("node", "Node.js"),
    ("python", "Python"),
    ("go", "Go"),
    ("rustc", "Rust"),
    ("java", "Java"),
    ("dotnet", ".NET"),
    // 包管理器
    ("npm", "npm"),
    ("pnpm", "pnpm"),
    ("yarn", "Yarn"),
    ("pip", "pip"),
    ("cargo", "Cargo"),
    ("uv", "uv"),
    // 容器
    ("docker", "Docker"),
    ("kubectl", "kubectl"),
    // 构建
    ("cmake", "CMake"),
    ("gradle", "Gradle"),
    ("mvn", "Maven"),
    // 云
    ("terraform", "Terraform"),
    ("aws", "AWS CLI"),
    ("gcloud", "Google Cloud CLI"),
    // AI 工具
    ("claude", "Claude Code"),
    ("codex", "Codex CLI"),
    ("gemini", "Gemini CLI"),
    ("opencode", "OpenCode"),
    // 效率
    ("rg", "ripgrep"),
    ("fd", "fd"),
    ("fzf", "fzf"),
    ("jq", "jq"),
    ("curl", "curl"),
];

/// 把参考清单里「扫描没发现」的工具以未安装状态补进结果。
fn append_reference_missing(
    tools: &mut Vec<DiscoveredCli>,
    seen: &BTreeMap<String, DiscoveredCli>,
) {
    for (name, display) in REFERENCE_CLIS {
        if seen.contains_key(&name.to_ascii_lowercase()) {
            continue;
        }
        // 名称展示用参考表里的规范名，命令名保留小写形式
        let _ = display;
        tools.push(DiscoveredCli {
            name: name.to_string(),
            source: "reference".to_string(),
            source_detail: "reference".to_string(),
            install_path: String::new(),
            version: String::new(),
            category: categorize(name).to_string(),
            installed: false,
        });
    }
}

/// 执行一次完整扫描。全程只读，结果只在内存里聚合。
pub fn scan() -> CliScanReport {
    let mut merged: BTreeMap<String, DiscoveredCli> = BTreeMap::new();
    let mut status = Vec::new();

    for (id, label, result) in run_sources() {
        let count = result.tools.len();
        merge(&mut merged, result.tools);
        status.push(ScanSource {
            id: id.to_string(),
            label: label.to_string(),
            ok: result.ok,
            count,
            note: result.note,
        });
    }

    // 扫描结果里的工具全部是「已安装」
    let mut tools: Vec<DiscoveredCli> = merged.values().cloned().collect();
    // 补上参考清单里未安装的常用工具，让「已安装 / 未安装」可被看见
    append_reference_missing(&mut tools, &merged);

    tools.sort_by(|a, b| {
        // 已安装优先，其次按类别，最后按名称
        b.installed
            .cmp(&a.installed)
            .then_with(|| a.category.cmp(&b.category))
            .then_with(|| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()))
    });

    CliScanReport {
        tools,
        sources: status,
        scanned_at: chrono::Local::now().to_rfc3339(),
    }
}

// ---------------- 测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categorize_known_tools() {
        assert_eq!(categorize("git"), "version-control");
        assert_eq!(categorize("node"), "language");
        assert_eq!(categorize("npm"), "package-manager");
        assert_eq!(categorize("docker"), "container");
        assert_eq!(categorize("gradle"), "build");
        assert_eq!(categorize("terraform"), "cloud");
        assert_eq!(categorize("claude"), "ai-agent");
        assert_eq!(categorize("rg"), "productivity");
        // 无法归类时不能丢弃，落到 other
        assert_eq!(categorize("some-unknown-tool-xyz"), "other");
    }

    #[test]
    fn categorize_strips_windows_extension() {
        assert_eq!(categorize("git.exe"), "version-control");
        assert_eq!(categorize("npm.cmd"), "package-manager");
        assert_eq!(categorize("gradle.bat"), "build");
    }

    #[test]
    fn whitelist_rejects_unknown_program() {
        let err = run_whitelisted("curl", &["--version"], Duration::from_millis(50))
            .expect_err("curl 不在白名单内，必须拒绝");
        assert!(err.contains("白名单"), "错误信息应说明白名单拒绝：{err}");
    }

    #[test]
    fn probe_rejects_arbitrary_flags() {
        let program = Path::new("cmd.exe");
        let err = run_probe(program, "--exec-anything", Duration::from_millis(50))
            .expect_err("任意标志必须被拒绝");
        assert!(err.contains("允许范围"), "错误信息应说明标志受限：{err}");
    }

    #[test]
    fn source_rank_prefers_package_manager_then_path() {
        assert!(source_rank("package-manager") < source_rank("path"));
        // PATH 必须比 known-root 更具体：否则 python 会显示 WindowsApps 的占位程序
        assert!(source_rank("path") < source_rank("known-root"));
    }

    #[test]
    fn merge_keeps_more_specific_source_and_fills_gaps() {
        let mut map = BTreeMap::new();
        // 先放 PATH 的（较泛），再放 npm 的（更具体）
        merge(
            &mut map,
            vec![make_cli("foo", "path", "PATH", "C:/bin/foo.exe", "")],
        );
        merge(
            &mut map,
            vec![make_cli("foo", "package-manager", "npm", "", "1.2.3")],
        );
        let got = map.get("foo").expect("应保留一条");
        assert_eq!(got.source, "package-manager");
        assert_eq!(got.version, "1.2.3");
        // 更具体的来源原本没有路径，应从泛来源补上
        assert_eq!(got.install_path, "C:/bin/foo.exe");
    }

    #[test]
    fn merge_dedupes_case_insensitively() {
        let mut map = BTreeMap::new();
        merge(&mut map, vec![make_cli("Git", "path", "PATH", "C:/a", "")]);
        merge(&mut map, vec![make_cli("git", "path", "PATH", "C:/b", "")]);
        assert_eq!(map.len(), 1, "同名不同大小写必须合并");
    }

    #[test]
    fn merge_prefers_package_manager_over_path() {
        let mut map = BTreeMap::new();
        merge(
            &mut map,
            vec![make_cli("rg", "package-manager", "cargo", "C:/cargo/rg.exe", "14.0.0")],
        );
        merge(&mut map, vec![make_cli("rg", "path", "PATH", "C:/other/rg.exe", "")]);
        let got = map.get("rg").expect("应保留一条");
        assert_eq!(got.source, "package-manager");
        assert_eq!(got.version, "14.0.0");
        assert_eq!(got.install_path, "C:/cargo/rg.exe");
    }

    #[test]
    fn merge_prefers_path_over_known_root() {
        // 真实场景：python 同时出现在 PATH(Python313) 与 WindowsApps(占位程序)
        let mut map = BTreeMap::new();
        merge(
            &mut map,
            vec![make_cli("python", "known-root", "WindowsApps", "C:/WA/python.exe", "")],
        );
        merge(
            &mut map,
            vec![make_cli("python", "path", "PATH", "D:/Python313/python.exe", "")],
        );
        let got = map.get("python").expect("应保留一条");
        assert_eq!(got.source, "path", "PATH 比已知根目录更可信");
        assert_eq!(got.install_path, "D:/Python313/python.exe");
    }

    #[test]
    fn is_executable_name_filters_non_binaries() {
        assert!(is_executable_name(Path::new("a.exe")));
        assert!(is_executable_name(Path::new("a.CMD")));
        assert!(is_executable_name(Path::new("a.bat")));
        assert!(!is_executable_name(Path::new("a.txt")));
        assert!(!is_executable_name(Path::new("a")));
    }

    #[test]
    fn merged_lines_skips_blank_and_merges_streams() {
        let out = CommandOutput {
            ok: true,
            stdout: "v1.2.3\n\n".into(),
            stderr: "  warning: x  \n".into(),
            timed_out: false,
        };
        assert_eq!(out.merged_lines(), vec!["v1.2.3", "warning: x"]);
    }

    #[test]
    fn skip_path_dir_excludes_system_and_build_output() {
        // 系统目录：1291 条里 668 条来自这里，必须排除
        assert!(skip_path_dir(Path::new(r"C:\WINDOWS\system32")));
        assert!(skip_path_dir(Path::new(r"c:\windows\SysWOW64")));
        assert!(skip_path_dir(Path::new(r"C:\Windows")));
        // 应用执行别名：python.exe 是占位符，指向它会让人以为装错了 Python
        assert!(skip_path_dir(Path::new(
            r"C:\Users\dz\AppData\Local\Microsoft\WindowsApps"
        )));
        // 构建产物不是「安装的工具」
        assert!(skip_path_dir(Path::new(r"E:\proj\src-tauri\target\debug")));
        // deps 目录里全是测试二进制，也必须排除
        assert!(skip_path_dir(Path::new(
            r"E:\proj\src-tauri\target\debug\deps"
        )));
        assert!(skip_path_dir(Path::new(
            r"E:\proj\src-tauri\target\release\deps"
        )));
        // 真实工具目录必须保留
        assert!(!skip_path_dir(Path::new(r"D:\04-Tool\nodejs")));
        assert!(!skip_path_dir(Path::new(r"E:\dev-cache\cargo\bin")));
        assert!(!skip_path_dir(Path::new(r"C:\Users\dz\.local\bin")));
    }

    #[test]
    fn detect_shell_script_by_shebang() {
        let dir = std::env::temp_dir().join("agenthub-cliscan-test");
        let _ = std::fs::create_dir_all(&dir);
        let sh = dir.join("fake-npm");
        std::fs::write(&sh, "#!/bin/sh\necho hi\n").unwrap();
        assert!(looks_like_shell_script(&sh), "shebang 文件必须被识别为脚本");

        let exe = dir.join("real-bin");
        std::fs::write(&exe, b"MZ\x90\x00").unwrap();
        assert!(!looks_like_shell_script(&exe), "PE 文件不应被当成脚本");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pip_cli_index_detects_console_scripts() {
        let dir = std::env::temp_dir().join("agenthub-pip-index-test");
        let _ = std::fs::remove_dir_all(&dir);
        let dist = dir.join("mytool-1.0.0.dist-info");
        let _ = std::fs::create_dir_all(&dist);
        std::fs::write(
            dist.join("entry_points.txt"),
            "[console_scripts]\nmytool = mytool:main\n",
        )
        .unwrap();

        // `python -m pkg` 形式
        let pkg = dir.join("runnable");
        let _ = std::fs::create_dir_all(&pkg);
        std::fs::write(pkg.join("__main__.py"), "").unwrap();

        // 包名的 `-` 与 `_` 应等价
        let dist2 = dir.join("my-other-2.0.dist-info");
        let _ = std::fs::create_dir_all(&dist2);
        std::fs::write(dist2.join("entry_points.txt"), "[console_scripts]\nx = y:z\n").unwrap();

        // 纯库：没有入口
        let dist3 = dir.join("purelib-3.0.dist-info");
        let _ = std::fs::create_dir_all(&dist3);
        std::fs::write(dist3.join("METADATA"), "Name: purelib\n").unwrap();

        let index = PipCliIndex::build(&dir);
        assert!(index.has_cli("mytool"), "console_scripts 应命中");
        assert!(index.has_cli("runnable"), "__main__.py 应命中");
        assert!(index.has_cli("my_other"), "`-` 与 `_` 应等价");
        assert!(!index.has_cli("purelib"), "纯库不应命中");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sdk_bundled_dirs_are_detected() {
        // 这些目录一次贡献几十上百个编译器内部件，必须能被识别出来
        assert!(is_sdk_bundled_dir(Path::new(
            r"D:\03-SDK\Qt\6.8.3\mingw_64\bin"
        )));
        assert!(is_sdk_bundled_dir(Path::new(r"D:\03-SDK\JAVA\JDK21\bin")));
        assert!(is_sdk_bundled_dir(Path::new(
            r"D:\03-SDK\Python313\Scripts"
        )));
        assert!(is_sdk_bundled_dir(Path::new(r"D:\03-SDK\Qt\Tools\mingw1310_64\bin")));
        // 用户主动装的 CLI 目录不能被误判
        assert!(!is_sdk_bundled_dir(Path::new(r"D:\04-Tool\nodejs")));
        assert!(!is_sdk_bundled_dir(Path::new(r"E:\dev-cache\cargo\bin")));
        assert!(!is_sdk_bundled_dir(Path::new(r"C:\Users\dz\.local\bin")));
    }

    #[test]
    fn scan_dir_marks_sdk_bundled_entries() {
        let dir = std::env::temp_dir().join("agenthub-sdk-mark-test").join("JDK21").join("bin");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("javac.exe"), b"MZ").unwrap();
        let mut out = Vec::new();
        scan_dir(&dir, "path", "PATH", &mut out);
        assert_eq!(out.len(), 1);
        assert!(
            out[0].source_detail.ends_with("|sdk"),
            "SDK 目录里的程序应带 sdk 标记：{}",
            out[0].source_detail
        );
        let _ = std::fs::remove_dir_all(std::env::temp_dir().join("agenthub-sdk-mark-test"));
    }

    #[test]
    fn probe_path_must_be_inside_known_roots() {
        // install_path 来自前端 IPC：必须限定在 PATH / 已知根目录内，
        // 否则任意路径都会变成「执行入口」，绕过白名单。
        let outside = std::env::temp_dir().join("agenthub-evil-probe.exe");
        std::fs::write(&outside, b"MZ").unwrap();
        assert!(
            !is_probe_allowed(&outside),
            "临时目录里的可执行文件不得作为探测目标"
        );
        // 解析时应退回按命令名查找，而不是照用这个路径
        let resolved = resolve_probe_target("definitely-not-a-real-cli-xyz", &outside.to_string_lossy());
        assert!(
            resolved.is_none(),
            "不存在的命令名 + 非法路径应解析失败，而不是采用该路径"
        );
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn name_channel_rejects_any_path_component() {
        // name 同样来自 IPC。若允许携带路径，任意可执行文件都会变成执行入口。
        // 真实文件存在也不行。
        let evil = std::env::temp_dir().join("agenthub-evil-name.cmd");
        std::fs::write(&evil, b"@echo evil\r\n").unwrap();
        let as_str = evil.to_string_lossy().into_owned();

        assert!(
            resolve_program(&as_str).is_none(),
            "带路径的 name 必须被拒绝：{as_str}"
        );
        assert!(
            resolve_probe_target(&as_str, "").is_none(),
            "带路径的 name + 空 install_path 也必须解析失败"
        );
        // 相对路径与 .. 穿越同样拒绝
        assert!(resolve_program("..\\evil.cmd").is_none());
        assert!(resolve_program("./evil.cmd").is_none());
        assert!(resolve_program("C:\\Windows\\System32\\cmd.exe").is_none());
        // 纯命令名仍然可用
        assert!(resolve_program("node").is_some(), "裸命令名应能正常解析");

        let _ = std::fs::remove_file(&evil);
    }

    #[test]
    fn probe_path_inside_path_dir_is_allowed() {
        // 真实场景：node.exe 在 PATH 里，应被允许作为探测目标
        if let Some(node) = resolve_program("node") {
            assert!(
                is_probe_allowed(&node),
                "PATH 中的程序应被允许探测：{}",
                node.display()
            );
            let via = resolve_probe_target("node", &node.to_string_lossy());
            assert_eq!(via.as_deref(), Some(node.as_path()));
        }
    }

    #[test]
    fn reference_clis_are_marked_not_installed_when_missing() {
        let mut tools = Vec::new();
        let mut seen = BTreeMap::new();
        // 只有 npm 被扫描到
        seen.insert("npm".to_string(), make_cli("npm", "path", "PATH", "C:/npm.cmd", ""));
        tools.push(seen.get("npm").unwrap().clone());

        append_reference_missing(&mut tools, &seen);

        // 已发现的不能重复补
        assert_eq!(tools.iter().filter(|t| t.name == "npm").count(), 1);
        // 未发现的应用未安装状态补上
        let git = tools.iter().find(|t| t.name == "git").expect("git 应被补进清单");
        assert!(!git.installed, "补进的工具必须标记为未安装");
        assert_eq!(git.source, "reference");
        assert!(!git.category.is_empty(), "补进的工具也要有类别");
    }

    #[test]
    fn scan_timeout_is_configurable_and_has_sane_default() {
        // 默认值必须显著大于实测冷启动耗时（npm 约 8 秒）
        assert!(scan_timeout() >= Duration::from_secs(20));
    }

    /// 真实环境集成测试：默认忽略，手动跑 `cargo test --lib -- --ignored cliscan_real`
    #[test]
    #[ignore]
    fn cliscan_real_environment_report() {
        let report = scan();
        println!("\n=== 来源状态 ===");
        for s in &report.sources {
            println!("{:<12} ok={:<5} count={:<4} {}", s.id, s.ok, s.count, s.note);
        }
        println!("\n=== 工具（前 40） ===");
        for t in report.tools.iter().take(40) {
            println!(
                "{:<22} {:<16} {:<14} {:<10} {}",
                t.name, t.category, t.source_detail, t.version, t.install_path
            );
        }
        println!("\n共 {} 个工具", report.tools.len());

        // 不变式：每个工具必须有名字和类别
        for t in &report.tools {
            assert!(!t.name.is_empty(), "工具缺名字");
            assert!(!t.category.is_empty(), "工具缺类别");
        }
        // 不变式：清单里既有已安装也有未安装（参考清单补入）
        let installed = report.tools.iter().filter(|t| t.installed).count();
        let missing = report.tools.iter().filter(|t| !t.installed).count();
        println!("已安装 {installed} / 未安装 {missing}");
        assert!(installed > 0, "真实环境扫描应至少发现一个已安装工具");
        assert!(
            missing > 0,
            "参考清单里未安装的工具也应出现在清单中（供用户看到「可以装什么」）"
        );
        // 不变式：未安装项没有安装路径与版本
        for t in report.tools.iter().filter(|t| !t.installed) {
            assert!(
                t.install_path.is_empty(),
                "未安装的工具不应有安装路径: {}",
                t.name
            );
        }
        // 不变式：PATH 来源必须能拿到安装路径
        for t in &report.tools {
            if t.source == "path" {
                assert!(!t.install_path.is_empty(), "PATH 来源缺安装路径: {}", t.name);
            }
        }
        // 不变式：不应混入系统内部程序（未安装的参考项没有路径，不参与此检查）
        for t in &report.tools {
            assert!(
                !t.install_path.to_ascii_lowercase().contains("\\windows\\system32"),
                "system32 的程序不应进入清单: {}",
                t.name
            );
            assert!(
                !t.install_path.to_ascii_lowercase().contains("microsoft\\windowsapps"),
                "应用别名占位程序不应进入清单: {}",
                t.name
            );
        }
    }
}
