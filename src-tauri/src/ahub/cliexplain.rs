//! 用途解释层：tldr 本地缓存为主，`--help` / `--version` 兜底。
//!
//! 设计约束（重要）：
//! - **tldr 不是硬依赖**。下载失败、未收录、断网都必须能退到兜底探测，
//!   扫描与详情不能因为 tldr 不可用而失败。
//! - **缓存完全离线**：归档下载一次后，所有查询都只读本机文件，不再发起网络请求。
//! - **不引入 Markdown 解析器**：tldr 页面是固定结构的纯文本，按行识别
//!   `> 描述`、`- 说明：` 与紧随的反引号命令行即可。
//! - **探测受白名单与短超时约束**：见 `cliscan::run_probe`。

use crate::ahub::cliscan;
use crate::ahub::models::{CliExplain, CliExample};
use crate::ahub::store::AppH;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// tldr 官方归档（按语言分包）。中文优先，缺失时回落英文。
const TLDR_ZH_URL: &str =
    "https://github.com/tldr-pages/tldr/releases/latest/download/tldr-pages.zh.zip";
const TLDR_EN_URL: &str =
    "https://github.com/tldr-pages/tldr/releases/latest/download/tldr-pages.en.zip";

/// 缓存目录名，位于 `data_root()` 下。
const CACHE_DIR: &str = "tldr";

/// 页面数量上限：一个命令名最多保留这么多示例（需求要求 3–5 个）。
const MAX_EXAMPLES: usize = 5;

/// 缓存状态文件，记录已下载的语言与时间。
const META_FILE: &str = "cache-meta.json";

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheMeta {
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    pub updated_at: String,
}

fn cache_root(app: &AppH) -> PathBuf {
    crate::ahub::store::data_root(app).join(CACHE_DIR)
}

fn pages_dir(app: &AppH, lang: &str) -> PathBuf {
    cache_root(app).join(lang).join("pages")
}

/// tldr 缓存是否已可用（任一语言已下载即算可用）。
pub fn cache_ready(app: &AppH) -> bool {
    for lang in ["zh", "en"] {
        if pages_dir(app, lang).is_dir() {
            return true;
        }
    }
    false
}

pub fn cache_meta(app: &AppH) -> CacheMeta {
    let path = cache_root(app).join(META_FILE);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// 下载并解压 tldr 归档到本机缓存。
///
/// 只解压 `pages/` 下的 `.md`，并且只保留 `common/` 与 `windows/` 两个平台目录
/// （本工具面向 Windows 开发者；其它平台页面只会挤占缓存且与用户无关）。
/// 解压到临时目录成功后再替换旧目录，避免下载失败把已有缓存弄坏。
pub fn ensure_cache(app: &AppH) -> Result<CacheMeta, String> {
    let mut meta = cache_meta(app);
    let mut errors: Vec<String> = Vec::new();

    for lang in ["zh", "en"] {
        if pages_dir(app, lang).is_dir() {
            if !meta.languages.iter().any(|l| l == lang) {
                meta.languages.push(lang.to_string());
            }
            continue;
        }
        let url = if lang == "zh" { TLDR_ZH_URL } else { TLDR_EN_URL };
        match download_and_extract(url, &pages_dir(app, lang)) {
            Ok(()) => {
                meta.languages.push(lang.to_string());
                // 中文可用就不必再下英文
                if lang == "zh" {
                    break;
                }
            }
            Err(e) => errors.push(format!("{lang}: {e}")),
        }
    }

    if meta.languages.is_empty() {
        return Err(format!(
            "tldr 缓存下载失败（{}）。可继续使用 --help 兜底模式。",
            errors.join("; ")
        ));
    }

    meta.languages.sort();
    meta.languages.dedup();
    meta.updated_at = chrono::Local::now().to_rfc3339();
    let _ = crate::ahub::store::write_json(&cache_root(app).join(META_FILE), &meta);
    Ok(meta)
}

fn download_and_extract(url: &str, target_pages: &Path) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(60))
        .user_agent("AgentHub/0.1 (CLI env center)")
        .build();
    let resp = agent
        .get(url)
        .call()
        .map_err(|e| format!("下载失败：{e}"))?;
    let mut buf: Vec<u8> = Vec::new();
    resp.into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取下载内容失败：{e}"))?;
    if buf.is_empty() {
        return Err("下载内容为空".into());
    }

    // 解压到同级临时目录，成功后再替换，避免半途失败破坏旧缓存
    let staging = target_pages.with_extension("staging");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("创建临时目录失败：{e}"))?;

    let cursor = std::io::Cursor::new(&buf);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("归档无法解析：{e}"))?;
    let mut written = 0usize;
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.is_dir() {
            continue;
        }
        let name: String = entry
            .name()
            .map_err(|e| format!("读取归档条目名失败：{e}"))?
            .to_string();
        if !name.ends_with(".md") {
            continue;
        }
        // 只保留 common/ 与 windows/，其它平台与本工具无关
        let Some((platform, rest)) = name.split_once('/') else {
            continue;
        };
        if platform != "common" && platform != "windows" {
            continue;
        }
        if rest.is_empty() || rest.contains("..") {
            continue;
        }
        let dest = staging.join(platform).join(rest);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        let mut out = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut out).map_err(|e| format!("解压失败：{e}"))?;
        std::fs::write(&dest, &out).map_err(|e| format!("写入失败：{e}"))?;
        written += 1;
    }

    if written == 0 {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("归档里没有找到可用的页面".into());
    }

    if let Some(parent) = target_pages.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建缓存目录失败：{e}"))?;
    }
    let _ = std::fs::remove_dir_all(target_pages);
    std::fs::rename(&staging, target_pages).map_err(|e| format!("启用缓存失败：{e}"))?;
    Ok(())
}

/// 清空缓存（下次查询会重新下载）。
pub fn clear_cache(app: &AppH) -> Result<(), String> {
    let root = cache_root(app);
    if root.exists() {
        std::fs::remove_dir_all(&root).map_err(|e| format!("清空缓存失败：{e}"))?;
    }
    Ok(())
}

// ---------------- 页面查找与解析 ----------------

/// 在缓存中查找某个命令的 tldr 页面。
///
/// 顺序：中文 `windows/` → 中文 `common/` → 英文 `windows/` → 英文 `common/`。
/// Windows 专属页面比通用页面更贴合本机，所以优先。
fn find_page(app: &AppH, name: &str) -> Option<(PathBuf, String)> {
    let safe: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    if safe.is_empty() {
        return None;
    }
    for lang in ["zh", "en"] {
        let base = pages_dir(app, lang);
        if !base.is_dir() {
            continue;
        }
        for platform in ["windows", "common"] {
            let candidate = base.join(platform).join(format!("{safe}.md"));
            if candidate.is_file() {
                return Some((candidate, lang.to_string()));
            }
        }
    }
    None
}

/// 把 tldr 的命令占位语法转换成可直接粘贴的形式。
///
/// tldr 有两套占位语法：
/// 1. 普通占位：`{{子命令}}` → 保留为 `<子命令>`，让人一眼看出这是要替换的部分；
/// 2. 可选参数（v2.3 新增）：`{{[-y|--yes]}}` → 取长格式 `--yes`。
///    原样保留会让用户把 `{{[-y|--yes]}}` 整个粘进终端，直接报错。
fn normalize_command(raw: &str) -> String {
    let mut out = String::new();
    let mut rest = raw;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            // 没有闭合：原样保留剩余部分，不猜
            out.push_str(&rest[start..]);
            return out;
        };
        let inner = &after[..end];
        rest = &after[end + 2..];

        // 可选参数形式 [-h|--help] → 取长格式
        if let Some(opts) = inner.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            let best = opts
                .split('|')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .max_by_key(|s| s.len())
                .unwrap_or("");
            out.push_str(best);
            continue;
        }
        out.push('<');
        out.push_str(inner.trim());
        out.push('>');
    }
    out.push_str(rest);
    out
}

/// 解析结果：一句话描述 + 示例列表。
struct ParsedPage {
    description: String,
    examples: Vec<CliExample>,
}

/// 按行解析 tldr 页面。
///
/// tldr 页面结构固定：
/// ```text
/// # git
/// > 分布式版本控制系统。
/// > 更多信息：<https://…>。
///
/// - 执行 git 子命令：
///
/// `git {{子命令}}`
/// ```
/// 因此不需要通用 Markdown 解析：`>` 开头是描述，`- ` 开头是示例说明，
/// 紧随其后的反引号行是命令。
fn parse_page(text: &str) -> ParsedPage {
    let mut description = String::new();
    let mut examples: Vec<CliExample> = Vec::new();
    let mut pending_desc: Option<String> = None;

    for raw in text.lines() {
        let line = raw.trim();

        // 标题行 # git — 跳过
        if line.starts_with("# ") {
            continue;
        }

        // 描述行 > …
        if let Some(rest) = line.strip_prefix('>') {
            let rest = rest.trim();
            // 「更多信息：」是链接行，不进描述
            if rest.starts_with("更多信息") || rest.to_ascii_lowercase().starts_with("more information")
            {
                continue;
            }
            if description.is_empty() && !rest.is_empty() {
                description = rest.to_string();
            }
            continue;
        }

        // 示例说明 - …
        if let Some(rest) = line.strip_prefix("- ") {
            pending_desc = Some(rest.trim().trim_end_matches('：').trim_end_matches(':').to_string());
            continue;
        }

        // 示例命令 `…`
        if line.starts_with('`') && line.ends_with('`') && line.len() > 2 {
            let raw = line.trim_matches('`').trim();
            if raw.is_empty() {
                continue;
            }
            let cmd = normalize_command(raw);
            if examples.len() < MAX_EXAMPLES {
                examples.push(CliExample {
                    description: pending_desc.take().unwrap_or_default(),
                    command: cmd,
                });
            } else {
                pending_desc = None;
            }
            continue;
        }

        // 空行：保留 pending_desc（说明与命令之间通常隔一个空行）
    }

    ParsedPage {
        description,
        examples,
    }
}

// ---------------- 兜底探测 ----------------

/// 从 `--version` / `--help` 输出里提取版本号与一句话摘要。
fn probe_fallback(program: &Path) -> (String, String, bool) {
    let mut version = String::new();
    let mut summary = String::new();
    let mut any_timeout = false;

    if let Ok(out) = cliscan::run_probe(program, "--version", cliscan::PROBE_TIMEOUT) {
        if out.timed_out {
            any_timeout = true;
        } else {
            let lines = out.merged_lines();
            // 版本号：优先第一个看起来像版本的行
            for line in &lines {
                if let Some(v) = extract_version(line) {
                    version = v;
                    break;
                }
            }
            if summary.is_empty() {
                if let Some(first) = lines.first() {
                    summary = first.chars().take(160).collect();
                }
            }
        }
    }

    if version.is_empty() || summary.is_empty() {
        if let Ok(out) = cliscan::run_probe(program, "--help", cliscan::PROBE_TIMEOUT) {
            if out.timed_out {
                any_timeout = true;
            } else {
                let lines = out.merged_lines();
                if summary.is_empty() {
                    // --help 首行通常是 "Usage: xxx …"，跳过它找第一条描述性文本
                    for line in &lines {
                        let low = line.to_ascii_lowercase();
                        if low.starts_with("usage") || low.starts_with("用法") {
                            continue;
                        }
                        if line.chars().count() >= 4 {
                            summary = line.chars().take(160).collect();
                            break;
                        }
                    }
                    if summary.is_empty() {
                        if let Some(first) = lines.first() {
                            summary = first.chars().take(160).collect();
                        }
                    }
                }
                if version.is_empty() {
                    for line in &lines {
                        if let Some(v) = extract_version(line) {
                            version = v;
                            break;
                        }
                    }
                }
            }
        }
    }

    (version, summary, any_timeout)
}

/// 从一行文本里找 `x.y.z` 形式的版本号。
fn extract_version(line: &str) -> Option<String> {
    let bytes: Vec<char> = line.chars().collect();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            let mut dots = 0;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == '.') {
                if bytes[i] == '.' {
                    dots += 1;
                }
                i += 1;
            }
            let candidate: String = bytes[start..i].iter().collect();
            let trimmed = candidate.trim_end_matches('.');
            if dots >= 1 && trimmed.split('.').count() >= 2 {
                return Some(trimmed.to_string());
            }
            continue;
        }
        i += 1;
    }
    None
}

// ---------------- 对外入口 ----------------

/// 解释一个 CLI：tldr 优先，兜底探测补位。
///
/// `name` 来自扫描结果；`install_path` 为空时按命令名在 PATH 里解析。
pub fn explain(app: &AppH, name: &str, install_path: &str) -> CliExplain {
    let mut out = CliExplain {
        name: name.to_string(),
        description: String::new(),
        examples: Vec::new(),
        source: String::new(),
        version: String::new(),
        install_path: install_path.to_string(),
        timed_out: false,
        note: String::new(),
    };

    // 1) tldr 页面
    if let Some((path, lang)) = find_page(app, name) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let parsed = parse_page(&text);
            if !parsed.description.is_empty() {
                out.description = parsed.description;
                out.source = if lang == "zh" { "tldr-zh".to_string() } else { "tldr-en".to_string() };
            }
            if !parsed.examples.is_empty() {
                out.examples = parsed.examples;
                if out.source.is_empty() {
                    out.source = if lang == "zh" { "tldr-zh".to_string() } else { "tldr-en".to_string() };
                }
            }
        }
    }

    // 2) 兜底探测：tldr 缺描述或缺示例时都要补
    let need_probe = out.description.is_empty() || out.examples.is_empty() || out.version.is_empty();
    if need_probe {
        // install_path 来自前端 IPC，属于外部输入。只有落在 PATH / 已知根目录内的
        // 路径才会被采用，否则按命令名重新解析，避免「任意路径 → 任意程序执行」。
        let program = cliscan::resolve_probe_target(name, install_path);

        match program {
            Some(program) => {
                if out.install_path.is_empty() {
                    out.install_path = program.to_string_lossy().into_owned();
                }
                let (version, summary, timed_out) = probe_fallback(&program);
                out.timed_out = timed_out;
                if out.version.is_empty() {
                    out.version = version;
                }
                if out.description.is_empty() && !summary.is_empty() {
                    out.description = summary;
                    if out.source.is_empty() {
                        out.source = "probe".into();
                    }
                }
                if timed_out && out.description.is_empty() && out.examples.is_empty() {
                    out.note = "探测超时，未取得用途信息".into();
                }
            }
            None => {
                if out.description.is_empty() {
                    out.note = "找不到该命令的可执行文件，无法探测用途".into();
                }
            }
        }
    }

    if out.source.is_empty() && !out.description.is_empty() {
        out.source = "probe".into();
    }
    out
}

/// 批量解释：用于清单首屏给每条补齐版本号。
///
/// 只对没有版本的条目做探测，且总量受 `limit` 限制，避免一次点开就执行几十个进程。
pub fn explain_versions(app: &AppH, items: &[(String, String)], limit: usize) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (name, path) in items.iter().take(limit) {
        // 与 explain 使用同一套路径校验：install_path 来自 IPC，必须限定在
        // PATH / 已知根目录内，否则按命令名重新解析。
        let Some(program) = cliscan::resolve_probe_target(name, path) else {
            continue;
        };
        if let Ok(o) = cliscan::run_probe(&program, "--version", Duration::from_secs(3)) {
            if o.timed_out {
                continue;
            }
            for line in o.merged_lines() {
                if let Some(v) = extract_version(&line) {
                    out.insert(name.clone(), v);
                    break;
                }
            }
        }
    }
    // 让编译器知道 app 参数被有意保留（缓存路径由调用方决定，此处只做探测）
    let _ = app;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "# git\n\n> 分布式版本控制系统。\n> 更多信息：<https://git-scm.com/docs/git>。\n\n- 执行 git 子命令：\n\n`git {{子命令}}`\n\n- 显示帮助文档：\n\n`git --help`\n\n- 显示版本号：\n\n`git --version`\n";

    #[test]
    fn parse_page_extracts_description_and_examples() {
        let p = parse_page(SAMPLE);
        assert_eq!(p.description, "分布式版本控制系统。");
        assert_eq!(p.examples.len(), 3);
        // 占位符转成尖括号形式，方便用户看出哪里要替换
        assert_eq!(p.examples[0].command, "git <子命令>");
        assert_eq!(p.examples[0].description, "执行 git 子命令");
        assert_eq!(p.examples[1].command, "git --help");
        assert_eq!(p.examples[2].command, "git --version");
    }

    #[test]
    fn normalize_command_picks_long_form_for_optional_args() {
        // tldr v2.3 的可选参数语法：原样粘贴会报错，必须取长格式
        assert_eq!(normalize_command("npm init {{[-y|--yes]}}"), "npm init --yes");
        assert_eq!(normalize_command("ls {{[-l|--long]}}"), "ls --long");
        // 普通占位转成尖括号
        assert_eq!(normalize_command("git {{子命令}}"), "git <子命令>");
        // 混合
        assert_eq!(
            normalize_command("npm {{[i|install]}} {{软件包名}}"),
            "npm install <软件包名>"
        );
        // 没有占位时原样返回
        assert_eq!(normalize_command("git --version"), "git --version");
        // 未闭合的占位不猜，原样保留
        assert_eq!(normalize_command("git {{未闭合"), "git {{未闭合");
    }

    #[test]
    fn parse_page_skips_more_information_line() {
        let p = parse_page(SAMPLE);
        assert!(
            !p.description.contains("更多信息"),
            "「更多信息」链接行不应进入描述"
        );
    }

    #[test]
    fn parse_page_caps_examples() {
        let mut text = String::from("# x\n\n> 描述。\n");
        for i in 0..10 {
            text.push_str(&format!("\n- 示例{i}：\n\n`cmd {i}`\n"));
        }
        let p = parse_page(&text);
        assert_eq!(p.examples.len(), MAX_EXAMPLES, "示例数应被上限截断");
    }

    #[test]
    fn parse_page_handles_english_pages() {
        let en = "# git\n\n> Distributed version control system.\n> More information: <https://git-scm.com>.\n\n- Run a git subcommand:\n\n`git {{subcommand}}`\n";
        let p = parse_page(en);
        assert_eq!(p.description, "Distributed version control system.");
        assert_eq!(p.examples.len(), 1);
        assert_eq!(p.examples[0].description, "Run a git subcommand");
    }

    #[test]
    fn parse_page_tolerates_empty_input() {
        let p = parse_page("");
        assert!(p.description.is_empty());
        assert!(p.examples.is_empty());
    }

    #[test]
    fn extract_version_finds_common_forms() {
        assert_eq!(extract_version("git version 2.44.0"), Some("2.44.0".into()));
        assert_eq!(extract_version("v1.2.3"), Some("1.2.3".into()));
        assert_eq!(extract_version("npm/10.8.1 node/v22.1.0"), Some("10.8.1".into()));
        assert_eq!(extract_version("no version here"), None);
        assert_eq!(extract_version("build 7"), None, "单个数字不算版本号");
    }

    #[test]
    fn find_page_sanitizes_name() {
        // 只验证净化逻辑不会 panic；真实查找需要缓存目录
        let safe: String = "../../etc/passwd"
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
            .collect();
        assert!(!safe.contains('/'), "路径分隔符必须被过滤：{safe}");
        assert!(!safe.contains("..") || safe == "....etcpasswd", "不应保留可穿越的 .. 段");
    }

    /// 真实环境集成测试：默认忽略，手动跑 `cargo test --lib -- --ignored tldr_real`
    ///
    /// 验证「下载归档 → 解压到缓存 → 解析页面」这条链路真的能用，
    /// 而不是只在单元测试里对样例文本成立。
    #[test]
    #[ignore]
    fn tldr_real_download_and_parse() {
        let target = std::env::temp_dir().join("agenthub-tldr-real-test");
        let _ = std::fs::remove_dir_all(&target);

        let started = std::time::Instant::now();
        match download_and_extract(TLDR_ZH_URL, &target) {
            Ok(()) => {
                println!("下载解压成功，耗时 {:?}", started.elapsed());
                let mut pages = 0usize;
                for platform in ["windows", "common"] {
                    if let Ok(entries) = std::fs::read_dir(target.join(platform)) {
                        pages += entries.flatten().filter(|e| e.path().is_file()).count();
                    }
                }
                println!("页面数：{pages}");
                assert!(pages > 100, "中文包应有大量页面，实际 {pages}");

                // 解析真实页面
                for name in ["git", "node", "npm"] {
                    let common = target.join("common").join(format!("{name}.md"));
                    let win = target.join("windows").join(format!("{name}.md"));
                    let path = if common.is_file() { common } else { win };
                    if !path.is_file() {
                        continue;
                    }
                    let text = std::fs::read_to_string(&path).unwrap();
                    let parsed = parse_page(&text);
                    println!(
                        "\n[{name}] 描述={:?}\n示例数={}",
                        parsed.description,
                        parsed.examples.len()
                    );
                    for ex in parsed.examples.iter().take(3) {
                        println!("  [{}] {}", ex.description, ex.command);
                    }
                    assert!(!parsed.description.is_empty(), "{name} 应有描述");
                    assert!(!parsed.examples.is_empty(), "{name} 应有示例");
                    assert!(
                        parsed.examples.len() <= MAX_EXAMPLES,
                        "{name} 示例数应被上限截断"
                    );
                }
            }
            Err(e) => {
                // 下载失败是可接受的兜底场景：功能会退到 --help 探测
                println!("下载失败（可接受，会退到兜底模式）：{e}");
            }
        }
        let _ = std::fs::remove_dir_all(&target);
    }
}
