//! 作用域设置 + 每功能日志（P5 的 B 半截，契约抄自 WinIsland 的插件系统）。
//!
//! 为什么先只做这一半：WinIsland 的完整插件契约（manifest / 生命周期 / 熔断 / 隔离）
//! 是为「第三方代码跑进来」设计的，我们还没有那种插件。但「一个功能带一份自己的
//! 设置与日志」现在就用得上 —— 无人值守的动作（定时 AI、技能摘要）失败了没地方看。
//! 等将来接可执行插件，这份就是地基：id 规矩、键前缀、日志文件都照它来。
//!
//! 用法：`id` 是功能自己的名字（如 `schedule-ai`、`dock-float`），设置存
//! `scopes/<id>.json`（浅合并），日志写 `logs/<id>.log`（超 256KB 砍旧一半）。

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// id 规矩抄自 WinIsland 的 plugin.json：小写字母数字连字符，2-64 位。
/// 谁想拿 id 乱写路径（`..`、绝对路径、大写）都在这一道拦下。
pub fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() >= 2
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn scope_file(root: &Path, id: &str) -> PathBuf {
    root.join("scopes").join(format!("{id}.json"))
}

fn log_file(root: &Path, id: &str) -> PathBuf {
    root.join("logs").join(format!("{id}.log"))
}

/// 读一个作用域的全部设置。没有就返回空表（第一次使用不必先创建）。
pub fn scope_read(root: &Path, id: &str) -> Result<Map<String, Value>, String> {
    if !valid_id(id) {
        return Err(format!("SCOPE_ID_INVALID: {id}"));
    }
    let path = scope_file(root, id);
    if !path.exists() {
        return Ok(Map::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .ok_or_else(|| format!("SCOPE_CORRUPT: {id}"))
}

/// 浅合并一个补丁（键级覆盖；深合并留给真正需要它的那天）。
pub fn scope_write(root: &Path, id: &str, patch: Map<String, Value>) -> Result<Map<String, Value>, String> {
    let mut current = scope_read(root, id)?;
    for (key, value) in patch {
        current.insert(key, value);
    }
    let path = scope_file(root, id);
    std::fs::create_dir_all(path.parent().ok_or("SCOPE_PATH")?).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&current).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(current)
}

const LOG_CAP: u64 = 256 * 1024;

/// 追加一行日志。超 256KB 就砍掉旧的一半：日志是给人翻最近的，不是档案。
pub fn log_append(root: &Path, id: &str, level: &str, message: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("SCOPE_ID_INVALID: {id}"));
    }
    let path = log_file(root, id);
    std::fs::create_dir_all(path.parent().ok_or("LOG_PATH")?).map_err(|e| e.to_string())?;
    let mut content = std::fs::read_to_string(&path).unwrap_or_default();
    content
        .push_str(&format!("{} [{}] {}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), level, message));
    if content.len() as u64 > LOG_CAP {
        let cut = content.len() / 2;
        content = match content[cut..].find('\n') {
            Some(pos) => content[cut + pos + 1..].to_string(),
            None => String::new(),
        };
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// 倒序取最近 n 行（最新在前）。
pub fn log_tail(root: &Path, id: &str, limit: usize) -> Result<Vec<String>, String> {
    if !valid_id(id) {
        return Err(format!("SCOPE_ID_INVALID: {id}"));
    }
    let text = std::fs::read_to_string(log_file(root, id)).unwrap_or_default();
    Ok(text.lines().rev().take(limit).map(str::to_string).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nimbus-scoped-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn id_rules_follow_winisland_manifest() {
        assert!(valid_id("schedule-ai"));
        assert!(!valid_id("a")); // 至少两位
        assert!(!valid_id("Schedule")); // 只许小写
        assert!(!valid_id("../escape"));
        assert!(!valid_id("has_underscore"));
    }

    #[test]
    fn scope_roundtrip_and_merge() {
        let root = temp_root("merge");
        let patch = Map::from_iter([("enabled".into(), Value::Bool(true))]);
        let merged = scope_write(&root, "dock-float", patch).unwrap();
        assert_eq!(merged.get("enabled"), Some(&Value::Bool(true)));
        // 第二次写入只覆盖给的键
        let patch2 = Map::from_iter([("volume".into(), Value::from(7))]);
        let merged = scope_write(&root, "dock-float", patch2).unwrap();
        assert_eq!(merged.get("enabled"), Some(&Value::Bool(true)));
        assert_eq!(merged.get("volume"), Some(&Value::from(7)));
    }

    #[test]
    fn missing_scope_is_empty_map() {
        let root = temp_root("empty");
        assert!(scope_read(&root, "nothing").unwrap().is_empty());
    }

    #[test]
    fn log_cap_drops_old_half_but_keeps_latest() {
        let root = temp_root("cap");
        let big = "x".repeat(60 * 1024);
        for i in 0..6 {
            log_append(&root, "schedule-ai", "info", &format!("{i}-{big}")).unwrap();
        }
        let tail = log_tail(&root, "schedule-ai", 3).unwrap();
        assert_eq!(tail.len(), 3);
        // 最新的一条一定还在；文件大小压在上限附近
        assert!(tail[0].contains("5-"));
        assert!(std::fs::metadata(log_file(&root, "schedule-ai")).unwrap().len() <= LOG_CAP + 64 * 1024);
    }

    #[test]
    fn tail_reads_newest_first() {
        let root = temp_root("tail");
        log_append(&root, "schedule-ai", "info", "first").unwrap();
        log_append(&root, "schedule-ai", "error", "boom").unwrap();
        let tail = log_tail(&root, "schedule-ai", 2).unwrap();
        assert!(tail[0].contains("boom"));
        assert!(tail[1].contains("first"));
    }
}
