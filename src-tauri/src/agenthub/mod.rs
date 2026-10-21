//! 工具箱（AgentHub「工具箱」迁移）：技能 / 提示词 / MCP 服务 / 本机工具收集分发。
//!
//! 数据落在 `<数据目录>/modules/agenthub/`。选 `modules/` 而不是别处的原因：
//! `database::snapshot_to`（更换数据目录）只会搬 `*.json` 兼容状态与整个
//! `modules/`，因此放在这里的数据会随「换目录」一起走，不会让用户换完目录
//! 发现技能没了。任务附件（`modules/plans/tasks/...`）已是同一先例。
//!
//! 技能是「目录 + 任意资源」，必须留在文件系统上而不是 SQLite：别家工具
//! （Claude Code / OpenCode / Codex …）也要能直接读它 —— 这正是收集与分发的前提。

pub mod harness;
pub mod mcp;
pub mod models;
pub mod prompts;
pub mod skills;

use models::{TbRoots, TbVersion};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

const DIR: &str = "agenthub";
static SEQ: AtomicU32 = AtomicU32::new(0);

/// 数据根 `<数据目录>/modules/agenthub`，并确保四个子目录存在。
pub fn root() -> Result<PathBuf, String> {
    let dir = crate::commands::data::with_data_dir(|data| Ok(data.join("modules").join(DIR)))?;
    for sub in ["skills", "prompts", "mcp"] {
        std::fs::create_dir_all(dir.join(sub)).map_err(|e| format!("创建 {} 失败: {e}", dir.join(sub).display()))?;
    }
    Ok(dir)
}

pub fn skills_dir() -> Result<PathBuf, String> {
    Ok(root()?.join("skills"))
}

pub fn prompts_dir() -> Result<PathBuf, String> {
    Ok(root()?.join("prompts"))
}

pub fn mcp_dir() -> Result<PathBuf, String> {
    Ok(root()?.join("mcp"))
}

pub fn roots() -> Result<TbRoots, String> {
    let root = root()?;
    let s = |p: PathBuf| p.to_string_lossy().into_owned();
    Ok(TbRoots {
        skills: s(root.join("skills")),
        prompts: s(root.join("prompts")),
        mcp: s(root.join("mcp")),
        root: s(root),
    })
}

// ---------------- 时间 / 标识 ----------------

/// Unix 秒 → `YYYY-MM-DDTHH:MM:SSZ`（UTC）。
///
/// 不引 chrono：这里只需要一个能排序、也能被前端的 `new Date()` 解析的字符串。
pub fn iso_from_secs(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Howard Hinnant 的 days→civil 算法（1970-01-01 = 第 0 天）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    iso_from_secs(secs)
}

/// 新条目 id。同一毫秒内多次创建时靠计数器避开重名。
pub fn new_id(prefix: &str) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{prefix}{millis}_{}", SEQ.fetch_add(1, Ordering::Relaxed))
}

/// 备份名里的时间戳（本地时间不参与，只用摘要式的紧凑 UTC）。
pub fn stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    iso_from_secs(secs).replace(['-', ':', 'T', 'Z'], "").replace(' ', "")
}

// ---------------- 文件 ----------------

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let text = crate::atomic::read_file_with_fallback(&path.to_string_lossy()).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("解析 {} 失败: {e}", path.display()))
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    crate::atomic::write_file_atomic(&path.to_string_lossy(), text.as_bytes())
        .map_err(|e| format!("写入 {} 失败: {e}", path.display()))
}

/// 读一份 `.hub.json` 一类的 sidecar；不存在/损坏都当作空对象。
///
/// 用 `Value` 而不是强类型，是为了**原样保住未知字段**：用户的 sidecar 里可能
/// 有源侧才认识的 `vetReport` / `summary`，云台改 `tags` 时不能顺手把它们删掉。
pub fn read_sidecar(path: &Path) -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| match v {
            serde_json::Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default()
}

/// 目录体积与文件数。`skip` 里的文件名不计入 —— 技能目录里的 `.hub.json`
/// 是工具自己的 sidecar，算进「技能有多少个文件」会误导。
pub fn dir_size_and_count(path: &Path, skip: &[&str]) -> Result<(u64, usize), String> {
    let mut bytes = 0u64;
    let mut count = 0usize;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if !skip.contains(&entry.file_name().to_string_lossy().as_ref()) {
                bytes += meta.len();
                count += 1;
            }
        }
    }
    Ok((bytes, count))
}

/// 目录树里最新的修改时间（ISO8601；全树读不到时间戳时用当前时间）。
pub fn newest_mtime(path: &Path) -> String {
    let mut newest: Option<std::time::SystemTime> = None;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if let Ok(t) = meta.modified() {
                newest = Some(newest.map_or(t, |n| n.max(t)));
            }
        }
    }
    let secs = newest
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    iso_from_secs(secs)
}

// ---------------- 备份 / 复制 ----------------

/// 写外部文件前留一份同目录备份：`<name>.agenthub-bak-<stamp>`。
///
/// 后缀沿用 AgentHub 的叫法（一个明显的、不会被别家工具当作配置读到的旁路文件），
/// 便于用户按迁移说明对照查找。目标文件不存在时不产生备份。
pub fn backup_file(path: &Path) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let target = path.with_file_name(format!("{name}.agenthub-bak-{}", stamp()));
    std::fs::copy(path, &target).map_err(|e| format!("备份 {} 失败: {e}", path.display()))?;
    Ok(Some(target))
}

/// 复制目录树时总是跳过的「噪声」名。**不默认跳过点文件**：技能目录里的
/// `.hub.json` 是来源工具的标签与版本，收集时跳过它就会丢信息。
pub const COPY_SKIP: &[&str] = &[".git", ".svn", ".hg", "node_modules", "__pycache__", ".DS_Store"];

pub fn copy_dir_recursive(src: &Path, dst: &Path, extra_skip: &[&str]) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建 {} 失败: {e}", dst.display()))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("读取 {} 失败: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if COPY_SKIP.contains(&name.as_str()) || extra_skip.contains(&name.as_str()) {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        if from.is_dir() {
            copy_dir_recursive(&from, &to, extra_skip)?;
        } else if std::fs::copy(&from, &to).is_err() {
            // 单个资源文件复制失败不该毁掉整次收集：留下提示继续。
            eprintln!("[toolbox] 复制失败，已跳过 {from:?}");
        }
    }
    Ok(())
}

// ---------------- 版本快照 ----------------

/// 把「改动前的旧内容」记为一条版本（自动存档语义），上限 50 条。
pub fn push_version(versions: &mut Vec<TbVersion>, old_content: &str) {
    if old_content.is_empty() {
        return;
    }
    let v = versions.iter().map(|x| x.v).max().unwrap_or(0) + 1;
    versions.push(TbVersion {
        v,
        saved_at: now_iso(),
        note: String::new(),
        content: old_content.to_string(),
    });
    let len = versions.len();
    if len > 50 {
        versions.drain(0..len - 50);
    }
}

/// 发布语义：把**当前**正文记为一条版本。
///
///   · 正文为空 → 不记录（没有回滚价值）
///   · 与最后一条版本内容相同 → 不重复记录（否则连点两次出现两个相同节点）
///
/// 返回是否真的产生了新版本。
pub fn push_published(versions: &mut Vec<TbVersion>, content: &str, note: &str) -> bool {
    if content.is_empty() {
        return false;
    }
    if versions.last().map(|v| v.content.as_str()) == Some(content) {
        return false;
    }
    let v = versions.iter().map(|x| x.v).max().unwrap_or(0) + 1;
    versions.push(TbVersion {
        v,
        saved_at: now_iso(),
        note: note.to_string(),
        content: content.to_string(),
    });
    let len = versions.len();
    if len > 50 {
        versions.drain(0..len - 50);
    }
    true
}

/// 目录名：只允许单词路径段，挡掉 `..`、分隔符、盘符与隐藏目录。
pub fn safe_dir_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    let ok = !trimmed.is_empty()
        && trimmed != "."
        && trimmed != ".."
        && !trimmed.starts_with('.')
        && !trimmed.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        && trimmed.len() <= 96;
    if !ok {
        return Err(format!("非法目录名: {name}"));
    }
    Ok(trimmed.to_string())
}

/// 技能名 → 目录名。非 ASCII（例如纯中文名）压不出可用段时退回 `skill-<秒>`。
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if ch == '-' || ch == '_' {
            out.push(ch);
        } else if ch == ' ' || ch == '.' {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        format!("skill-{}", stamp())
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_epoch_formats_as_iso() {
        assert_eq!(iso_from_secs(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_from_secs(1_700_000_000), "2023-11-14T22:13:20Z");
        // 闰日与跨世纪：2024-02-29
        assert_eq!(iso_from_secs(1_709_164_800), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn backup_suffix_is_visible_and_absent_for_missing_file() {
        let dir = std::env::temp_dir().join(format!("nd-tb-bak-{}", new_id("t")));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("claude.json");
        assert!(backup_file(&file).unwrap().is_none(), "目标不存在时不该凭空造备份");
        std::fs::write(&file, b"{}").unwrap();
        let bak = backup_file(&file).unwrap().unwrap();
        let name = bak.file_name().unwrap().to_string_lossy();
        assert!(name.starts_with("claude.json.agenthub-bak-"), "实际: {name}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_directory_names_that_escape_the_skills_root() {
        for bad in ["..", "../x", "a/b", "a\\b", ".hidden", "c:evil", ""] {
            assert!(safe_dir_name(bad).is_err(), "{bad} 不该通过");
        }
        assert_eq!(safe_dir_name(" claude-skills ").unwrap(), "claude-skills");
    }

    #[test]
    fn slug_falls_back_for_non_ascii_names() {
        assert_eq!(slugify("My Skill.v2"), "my-skill-v2");
        assert!(slugify("中文技能").starts_with("skill-"));
    }

    /// 连点两次发布不该产生两条一样的时间轴节点（与源侧同一语义）
    #[test]
    fn publish_is_idempotent_for_same_content() {
        let mut versions: Vec<TbVersion> = Vec::new();
        assert!(push_published(&mut versions, "body", ""));
        assert!(!push_published(&mut versions, "body", ""));
        assert_eq!(versions.len(), 1);
        assert!(!push_published(&mut versions, "", ""));
        assert!(push_published(&mut versions, "body2", "note"));
        assert_eq!(versions.last().unwrap().note, "note");
    }

    #[test]
    fn auto_archive_keeps_the_last_fifty() {
        let mut versions: Vec<TbVersion> = Vec::new();
        for i in 0..60 {
            push_version(&mut versions, &format!("v{i}"));
        }
        assert_eq!(versions.len(), 50);
        assert_eq!(versions[0].content, "v10");
        assert_eq!(versions.last().unwrap().v, 60, "编号需接续而不是重头开始");
    }
}
