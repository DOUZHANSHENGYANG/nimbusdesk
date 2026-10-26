//! AI 工具版本管理：检查是否有新版本、按需更新。
//!
//! 设计约束（重要）：
//! - **只处理 npm 全局包**。GUI 桌面应用（Cursor / Claude Desktop / WorkBuddy …）
//!   没有统一可编程的更新入口，本模块不假装能更新它们。
//! - **安装事实以 `npm ls -g` 为准**，不靠"跑 CLI 取版本"。实测 `@openai/codex`
//!   可能缺可选依赖（win32-x64 原生包），此时连 bin shim 都不会生成、CLI 完全跑不起来；
//!   若以 CLI 为准会把它误判成"未安装"。故单独提供 `runnable` 判定。
//! - **只读不写**：检查最新版只做 registry 查询。
//! - 更新只会执行 `npm i -g <包名>@latest`，包名来自本文件的静态表，不接受外部输入。

use serde::Serialize;
use std::collections::BTreeMap;

/// 一个 AI 工具与它的 npm 包映射。
struct ToolDef {
    /// 与 `harness.rs` 的 HarnessDef.id 对应，前端用它把图标/配置串起来。
    id: &'static str,
    name: &'static str,
    /// npm 包名；空表示不是 npm 分发的 CLI（不参与检查/更新）。
    pkg: &'static str,
    /// 校验 CLI 是否真能跑起来的命令（不含扩展名，Windows 上会补 `.cmd`）。
    /// 空表示跳过可运行性检测。
    probe: &'static str,
}

/// 静态映射表：只列确实由 npm 全局安装的 CLI。
///
/// 不含的（有意）：
/// - Cursor / Windsurf / VS Code / Claude Desktop / Cline / WorkBuddy → GUI 应用，无 npm 包
/// - custom-dirs → 不是工具，是用户自定义技能目录
const TOOLS: &[ToolDef] = &[
    ToolDef { id: "claude-code", name: "Claude Code", pkg: "@anthropic-ai/claude-code", probe: "claude" },
    ToolDef { id: "codex", name: "Codex CLI", pkg: "@openai/codex", probe: "codex" },
    ToolDef { id: "gemini-cli", name: "Gemini CLI", pkg: "@google/gemini-cli", probe: "gemini" },
    ToolDef { id: "opencode", name: "OpenCode", pkg: "@opencode/cli", probe: "opencode" },
    ToolDef { id: "codebuddy", name: "CodeBuddy", pkg: "@tencent-ai/codebuddy-code", probe: "codebuddy" },
    ToolDef { id: "pi-agent", name: "PI Agent", pkg: "@earendil-works/pi-coding-agent", probe: "pi" },
    ToolDef { id: "deepseek", name: "DeepSeek", pkg: "@deepseek-ai/dsh", probe: "dsh" },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolVersion {
    pub id: String,
    pub name: String,
    pub pkg: String,
    /// npm 全局是否装了
    pub installed: bool,
    /// 已装版本（未装则空）
    pub current: String,
    /// registry 上的最新版（未查询则空）
    pub latest: String,
    /// 是否有更新（需要 latest 已查询且 current 有效）
    pub has_update: bool,
    /// 装了但 CLI 跑不起来（缺可选依赖等）
    pub broken: bool,
    /// 可运行性检测的说明（跑失败时的原因 / 未装时的提示）
    pub runnable_note: String,
}

/// 前端拉到的状态：工具列表 + npm 是否可用（不可用时检查/更新都无法进行）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolList {
    pub tools: Vec<ToolVersion>,
    pub npm_available: bool,
    pub npm_note: String,
}

// ---------------- 版本比较 ----------------

/// 语义化版本拆解：主/次/修订 + 预发布标记 + 原始串。
#[derive(Debug, PartialEq)]
struct Semver {
    nums: Vec<u64>,
    /// 预发布标识（`1.0.0-rc.2` 的 `rc.2`）；空表示正式版
    pre: String,
}

/// 解析版本号；允许前缀 `v`，允许缺省段（`1.2` → `1.2.0`）。
/// 非数字的构建元数据（`+build`）忽略。
fn parse_semver(s: &str) -> Option<Semver> {
    let s = s.trim();
    let s = s.strip_prefix('v').unwrap_or(s);
    if s.is_empty() {
        return None;
    }
    // 去掉构建元数据
    let s = s.split('+').next().unwrap_or(s);
    // 拆出预发布
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, p.to_string()),
        None => (s, String::new()),
    };
    let mut nums = Vec::new();
    for part in core.split('.') {
        // 允许 "1.2.x" 之类：遇到非数字即判定为不可解析
        nums.push(part.parse::<u64>().ok()?);
    }
    if nums.is_empty() {
        return None;
    }
    while nums.len() < 3 {
        nums.push(0);
    }
    Some(Semver { nums, pre })
}

/// 判断 `latest` 是否比 `current` 新。任一无法解析时返回 false（宁可不提示，也不误报）。
fn is_newer(current: &str, latest: &str) -> bool {
    let (Some(c), Some(l)) = (parse_semver(current), parse_semver(latest)) else {
        return false;
    };
    match c.nums.cmp(&l.nums) {
        std::cmp::Ordering::Less => true,
        std::cmp::Ordering::Greater => false,
        // 数字段相同：正式版 > 预发布版（0.2.0-rc.2 → 0.2.0 算升级；反向不算）
        std::cmp::Ordering::Equal => !c.pre.is_empty() && l.pre.is_empty(),
    }
}

// ---------------- npm 交互 ----------------

/// Windows 上 npm/git 等是 `.cmd` 批处理；直接用 `Command::new("npm")` 会 "program not found"。
#[cfg(windows)]
fn npm_program() -> &'static str {
    "npm.cmd"
}
#[cfg(not(windows))]
fn npm_program() -> &'static str {
    "npm"
}

fn run_npm(args: &[&str]) -> Result<String, String> {
    let out = crate::ahub::store::silent_command(npm_program())
        .args(args)
        .output()
        .map_err(|e| format!("无法执行 npm：{e}（未安装 Node.js 或不在 PATH）"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() && stdout.trim().is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.trim().to_string());
    }
    Ok(stdout)
}

/// 解析 `npm ls -g --json --depth=0` 的输出 → 包名 → 版本。
fn parse_ls(json: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return out;
    };
    if let Some(deps) = v.get("dependencies").and_then(|d| d.as_object()) {
        for (name, info) in deps {
            if let Some(ver) = info.get("version").and_then(|x| x.as_str()) {
                out.insert(name.clone(), ver.to_string());
            }
        }
    }
    out
}

/// 已安装的 npm 全局包（一次调用拿全，避免每个工具跑一次 npm）。
fn installed_packages() -> Result<BTreeMap<String, String>, String> {
    let json = run_npm(&["ls", "-g", "--json", "--depth=0"])?;
    Ok(parse_ls(&json))
}

/// 检测某个 CLI 能否真正运行（拿版本）。返回 (可运行, 说明)。
fn probe_cli(cmd: &str) -> (bool, String) {
    if cmd.is_empty() {
        return (true, String::new());
    }
    #[cfg(windows)]
    let program = format!("{cmd}.cmd");
    #[cfg(not(windows))]
    let program = cmd.to_string();

    match crate::ahub::store::silent_command(&program)
        .arg("--version")
        .output()
    {
        Ok(o) if o.status.success() => (true, String::new()),
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr);
            let first = err
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("命令返回非零状态")
                .trim();
            (false, first.chars().take(160).collect())
        }
        Err(e) => (false, format!("命令不可用：{e}")),
    }
}

// ---------------- 对外命令 ----------------

/*
 * `list()` 的缓存。
 *
 * 实测：`npm ls -g --json` 一次 ~1.6 s，每个 CLI 的 `--version` 探针 0.1–0.2 s ×
 * 十几个（node 系的 CLI 启动本身就慢），而 Harness 目录扫描只要 ~26 ms。
 * 也就是这个页面「加载中」几乎全花在探针上 —— 每次进页面都重来一遍，
 * 所以给人的感觉是「一直在扫、还特别慢」。5 分钟 TTL：真装了新工具不用等太久，
 * 反复进出页面又不必重复探。更新/安装之后显式失效，避免显示旧版本。
 */
static LIST_CACHE: std::sync::Mutex<Option<(std::time::Instant, ToolList)>> = std::sync::Mutex::new(None);
const LIST_TTL: std::time::Duration = std::time::Duration::from_secs(300);

/// 装了/更新了工具之后调它，下一次 `list()` 重新探。
pub fn invalidate_list_cache() {
    if let Ok(mut guard) = LIST_CACHE.lock() {
        *guard = None;
    }
}

/// 列出工具及其本地安装状态。**不打 registry**，纯本地查询；结果按 TTL 缓存。
pub fn list() -> ToolList {
    if let Ok(guard) = LIST_CACHE.lock() {
        if let Some((at, cached)) = guard.as_ref() {
            if at.elapsed() < LIST_TTL {
                return cached.clone();
            }
        }
    }
    let fresh = list_uncached();
    if let Ok(mut guard) = LIST_CACHE.lock() {
        *guard = Some((std::time::Instant::now(), fresh.clone()));
    }
    fresh
}

fn list_uncached() -> ToolList {
    let mut out = match installed_packages() {
        Ok(inst) => ToolList {
            tools: TOOLS
                .iter()
                .map(|d| {
                    let current = inst.get(d.pkg).cloned().unwrap_or_default();
                    let installed = !current.is_empty();
                    let (broken, note) = if installed {
                        let (ok, why) = probe_cli(d.probe);
                        (!ok, why)
                    } else {
                        (false, String::new())
                    };
                    ToolVersion {
                        id: d.id.to_string(),
                        name: d.name.to_string(),
                        pkg: d.pkg.to_string(),
                        installed,
                        current,
                        latest: String::new(),
                        has_update: false,
                        broken,
                        runnable_note: note,
                    }
                })
                .collect(),
            npm_available: true,
            npm_note: String::new(),
        },
        Err(e) => ToolList {
            tools: TOOLS
                .iter()
                .map(|d| ToolVersion {
                    id: d.id.to_string(),
                    name: d.name.to_string(),
                    pkg: d.pkg.to_string(),
                    installed: false,
                    current: String::new(),
                    latest: String::new(),
                    has_update: false,
                    broken: false,
                    runnable_note: String::new(),
                })
                .collect(),
            npm_available: false,
            npm_note: e,
        },
    };
    // 已安装的排前面，未安装的沉到末尾
    sort_installed_first(&mut out.tools);
    out
}

/// 排序规则：已安装的在最前，未安装的排到末尾。
/// 同一组内保持静态表顺序（稳定排序），避免每次刷新顺序抖动。
fn sort_installed_first(tools: &mut [ToolVersion]) {
    tools.sort_by_key(|t| !t.installed);
}

/// 查询已安装工具的最新版本。只查已安装的（未装的不提示"可更新"）。
/// 逐个包查询，某个失败只影响它自己，不整体失败。
pub fn check_latest() -> ToolList {
    let mut list = list();
    if !list.npm_available {
        return list;
    }
    for tool in list.tools.iter_mut() {
        if !tool.installed {
            continue;
        }
        match run_npm(&["view", &tool.pkg, "version"]) {
            Ok(out) => {
                // 取最后一行非空内容（npm 可能先打印 warning）
                let latest = out
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .next_back()
                    .unwrap_or("")
                    .to_string();
                // 去掉可能的引号
                let latest = latest.trim_matches('"').to_string();
                if !latest.is_empty() {
                    tool.has_update = is_newer(&tool.current, &latest);
                    tool.latest = latest;
                }
            }
            Err(e) => {
                tool.runnable_note = format!("查询最新版失败：{e}");
            }
        }
    }
    list
}

/// 单个工具的更新结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOutcome {
    pub id: String,
    pub name: String,
    pub ok: bool,
    pub from: String,
    pub to: String,
    pub message: String,
}

/// 批量更新。逐个执行，单个失败不中断后续。
/// **包名只从静态表取**，前端传 id，不接受任意包名，避免被当作任意命令执行入口。
pub fn update(ids: &[String]) -> Vec<UpdateOutcome> {
    let before = installed_packages().unwrap_or_default();
    let mut out = Vec::new();
    for id in ids {
        let Some(def) = TOOLS.iter().find(|d| d.id == id) else {
            out.push(UpdateOutcome {
                id: id.clone(),
                name: id.clone(),
                ok: false,
                from: String::new(),
                to: String::new(),
                message: "未知工具".into(),
            });
            continue;
        };
        let from = before.get(def.pkg).cloned().unwrap_or_default();
        let res = run_npm(&["install", "-g", &format!("{}@latest", def.pkg)]);
        // 装完重新取版本（成功与失败都要看，npm 可能部分成功）
        let after = installed_packages().unwrap_or_default();
        let to = after.get(def.pkg).cloned().unwrap_or_default();
        match res {
            Ok(_) => {
                let (runnable, why) = probe_cli(def.probe);
                let mut message = if from == to {
                    format!("已是最新（{to}）")
                } else {
                    format!("{from} → {to}")
                };
                if !runnable {
                    message = format!("{message}；但命令仍无法运行：{why}");
                }
                out.push(UpdateOutcome {
                    id: def.id.to_string(),
                    name: def.name.to_string(),
                    ok: true,
                    from,
                    to,
                    message,
                });
            }
            Err(e) => out.push(UpdateOutcome {
                id: def.id.to_string(),
                name: def.name.to_string(),
                ok: false,
                from,
                to,
                message: e,
            }),
        }
    }
    // 装/更新完了，别让下一次 list() 还回缓存里的旧版本
    invalidate_list_cache();
    out
}

// ---------------- 测试 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_parses_common_forms() {
        assert_eq!(parse_semver("1.2.3").unwrap().nums, vec![1, 2, 3]);
        assert_eq!(parse_semver("v1.2.3").unwrap().nums, vec![1, 2, 3]);
        assert_eq!(parse_semver("1.2").unwrap().nums, vec![1, 2, 0]);
        assert_eq!(parse_semver("1").unwrap().nums, vec![1, 0, 0]);
        assert!(parse_semver("").is_none());
        assert!(parse_semver("abc").is_none());
    }

    #[test]
    fn semver_handles_prerelease_and_build() {
        let v = parse_semver("0.2.0-rc.2").unwrap();
        assert_eq!(v.nums, vec![0, 2, 0]);
        assert_eq!(v.pre, "rc.2");
        // 构建元数据被忽略
        assert_eq!(parse_semver("1.0.0+build5").unwrap().nums, vec![1, 0, 0]);
    }

    #[test]
    fn is_newer_detects_upgrades() {
        assert!(is_newer("0.153.4", "0.163.0"));
        assert!(is_newer("2.109.0", "2.168.2"));
        assert!(is_newer("1.12.7", "1.13.0"));
        assert!(is_newer("0.87.0", "1.3.0"));
    }

    #[test]
    fn is_newer_rejects_same_or_older() {
        assert!(!is_newer("2.0.31", "2.0.31"));
        assert!(!is_newer("2.0.31", "1.9.0"));
        assert!(!is_newer("1.2.3", "1.2.2"));
    }

    #[test]
    fn prerelease_is_older_than_release() {
        // 0.2.0-rc.2 → 0.2.0 是升级
        assert!(is_newer("0.2.0-rc.2", "0.2.0"));
        // 反向不是
        assert!(!is_newer("0.2.0", "0.2.0-rc.2"));
    }

    #[test]
    fn is_newer_is_silent_when_unparseable() {
        // 宁可漏报，不可误报
        assert!(!is_newer("", "1.0.0"));
        assert!(!is_newer("1.0.0", ""));
        assert!(!is_newer("garbage", "1.0.0"));
    }

    #[test]
    fn parse_ls_extracts_versions() {
        let json = r#"{
            "name": "npm_global",
            "dependencies": {
                "@openai/codex": { "version": "0.153.4", "overridden": false },
                "@opencode/cli": { "version": "2.0.31" },
                "broken": { "resolved": "file:..." }
            }
        }"#;
        let m = parse_ls(json);
        assert_eq!(m.get("@openai/codex").map(String::as_str), Some("0.153.4"));
        assert_eq!(m.get("@opencode/cli").map(String::as_str), Some("2.0.31"));
        // 没有 version 字段的条目被跳过
        assert!(!m.contains_key("broken"));
        assert_eq!(m.len(), 2);
    }

    #[test]
    fn parse_ls_survives_garbage() {
        assert!(parse_ls("not json").is_empty());
        assert!(parse_ls("{}").is_empty());
        assert!(parse_ls("").is_empty());
    }

    #[test]
    fn tool_table_covers_expected_clis() {
        // 防止误删/改名：这些 id 前端有图标映射
        let ids: Vec<&str> = TOOLS.iter().map(|d| d.id).collect();
        for want in ["claude-code", "codex", "opencode", "pi-agent", "codebuddy"] {
            assert!(ids.contains(&want), "缺少工具映射: {want}");
        }
        // 不能包含非 CLI（GUI 应用没有 npm 包）
        assert!(!ids.contains(&"cursor"), "Cursor 是 GUI 应用，不应参与 npm 更新");
        assert!(!ids.contains(&"custom-dirs"), "自定义目录不是工具");
    }

    /// 构造一个用于排序测试的 ToolVersion
    fn tv(id: &str, installed: bool) -> ToolVersion {
        ToolVersion {
            id: id.into(),
            name: id.into(),
            pkg: format!("pkg-{id}"),
            installed,
            current: if installed { "1.0.0".into() } else { String::new() },
            latest: String::new(),
            has_update: false,
            broken: false,
            runnable_note: String::new(),
        }
    }

    #[test]
    fn installed_tools_sort_first() {
        let mut v = vec![
            tv("a-uninstalled", false),
            tv("b-installed", true),
            tv("c-uninstalled", false),
            tv("d-installed", true),
        ];
        sort_installed_first(&mut v);
        let ids: Vec<&str> = v.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["b-installed", "d-installed", "a-uninstalled", "c-uninstalled"]);
    }

    #[test]
    fn sort_is_stable_within_groups() {
        // 同组内保持原顺序，避免每次刷新顺序抖动
        let mut v = vec![
            tv("u1", false),
            tv("i1", true),
            tv("u2", false),
            tv("i2", true),
            tv("u3", false),
        ];
        sort_installed_first(&mut v);
        let ids: Vec<&str> = v.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["i1", "i2", "u1", "u2", "u3"]);
    }

    #[test]
    fn sort_handles_all_installed_and_none_installed() {
        let mut all = vec![tv("x", true), tv("y", true)];
        sort_installed_first(&mut all);
        assert_eq!(all.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["x", "y"]);

        let mut none = vec![tv("x", false), tv("y", false)];
        sort_installed_first(&mut none);
        assert_eq!(none.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["x", "y"]);
    }

    #[test]
    fn uninstalled_are_never_updatable() {
        // 未安装的工具不应出现「有更新」——否则界面会给出无意义的更新按钮
        let mut t = tv("gemini-cli", false);
        t.latest = "9.9.9".into();
        t.has_update = is_newer(&t.current, &t.latest);
        assert!(!t.has_update, "未安装的工具不应标记为可更新");
    }

    #[test]
    fn every_tool_has_package_and_probe() {
        for d in TOOLS {
            assert!(!d.pkg.is_empty(), "{} 缺包名", d.id);
            assert!(!d.probe.is_empty(), "{} 缺探测命令", d.id);
        }
    }

    // ---- 真实环境集成测试：直接调用本模块逻辑，跑真 npm ----
    //
    // 默认 #[ignore]：结果依赖本机是否装了 npm / 哪些工具，不适合放进常规 CI。
    // 手动验证用：`cargo test --lib -- --ignored --nocapture toolmgr_real`
    //
    // 它存在的意义是防止"单元测试全绿但真实调用是坏的"——实测踩过两个坑：
    // 1. Rust 里 `Command::new("npm")` 在 Windows 上直接失败（必须 npm.cmd）
    // 2. codex 装了但 shim 不存在，靠跑 CLI 判断会把已安装误判成未安装

    #[test]
    #[ignore]
    fn toolmgr_real_environment_report() {
        let l = list();
        println!("
=== npm 可用: {} (note: {:?}) ===", l.npm_available, l.npm_note);
        if !l.npm_available {
            println!("npm 不可用，跳过后续检查");
            return;
        }

        println!("
{:<12} {:<38} {:<12} {:<10} {}", "id", "pkg", "current", "installed", "broken");
        for t in &l.tools {
            println!(
                "{:<12} {:<38} {:<12} {:<10} {}",
                t.id, t.pkg, if t.current.is_empty() { "-" } else { &t.current }, t.installed, t.broken
            );
            // 不变式：installed 为真时必须有版本号
            if t.installed {
                assert!(!t.current.is_empty(), "{} installed 但没有版本号", t.id);
            }
            // 不变式：broken 只有在 installed 时才可能为真
            if t.broken {
                assert!(t.installed, "{} 未安装却被标记 broken", t.id);
                assert!(!t.runnable_note.is_empty(), "{} broken 但没有原因", t.id);
            }
        }

        let c = check_latest();
        println!("
=== 检查最新版后 ===");
        let mut updatable = Vec::new();
        for t in &c.tools {
            if !t.installed {
                continue;
            }
            println!(
                "{:<12} {:<12} -> {:<12} has_update={}",
                t.id,
                if t.current.is_empty() { "-" } else { &t.current },
                if t.latest.is_empty() { "?" } else { &t.latest },
                t.has_update
            );
            if t.has_update {
                updatable.push(t.id.clone());
                // 不变式：声称有更新，则 latest 必须真的比 current 新
                assert!(is_newer(&t.current, &t.latest), "{} 误报有更新", t.id);
                assert_ne!(t.current, t.latest, "{} 版本号相同却报有更新", t.id);
            }
        }
        println!("
可更新: {:?}", updatable);
    }
}
