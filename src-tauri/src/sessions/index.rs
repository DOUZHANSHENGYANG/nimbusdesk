//! 会话列表的索引缓存。
//!
//! 扫描要按文件 mtime + size 判「有没有变」，没变就直接用上次解析出来的摘要，
//! 不再把几十 MB 的 JSONL 重新读一遍。会话正文（read）不走这里 —— 那是一次性的。
//!
//! 刻意做成**进程内**缓存：会话文件随时可能被宿主改写，落盘索引要处理失效、
//! 并发写、跨版本格式，收益却只是省一次冷启动扫描。mtime+size 变化即失效，
//! 是我们能接受的最简正确口径。
use crate::sessions::ir::SessionSummary;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FileStamp {
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Clone)]
struct Entry {
    stamp: FileStamp,
    summary: SessionSummary,
}

fn table() -> &'static Mutex<HashMap<String, Entry>> {
    static TABLE: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 读文件的大小与修改时间；读不到就返回 None（调用方按「必须解析」处理）。
pub(crate) fn stamp(path: &Path) -> Option<FileStamp> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(FileStamp { size: meta.len(), mtime_ms })
}

fn key(runtime: &str, path: &Path) -> String {
    format!("{runtime}|{}", path.to_string_lossy())
}

/// 命中且戳记一致才返回；否则 None（调用方去解析）。
pub(crate) fn lookup(runtime: &str, path: &Path, current: FileStamp) -> Option<SessionSummary> {
    let table = table().lock().ok()?;
    let entry = table.get(&key(runtime, path))?;
    if entry.stamp != current {
        return None;
    }
    #[cfg(test)]
    HITS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Some(entry.summary.clone())
}

/// 解析完写回（覆盖旧戳记）。
pub(crate) fn store(runtime: &str, path: &Path, current: FileStamp, summary: SessionSummary) {
    if let Ok(mut table) = table().lock() {
        table.insert(key(runtime, path), Entry { stamp: current, summary });
    }
}

/// 直接清空（测试用；将来若要「强制刷新列表」也走这里）。
#[allow(dead_code)]
pub(crate) fn clear() {
    if let Ok(mut table) = table().lock() {
        table.clear();
    }
}

#[cfg(test)]
pub(crate) static HITS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
pub(crate) fn hits() -> usize {
    HITS.load(std::sync::atomic::Ordering::Relaxed)
}

/// 记住一个已知摘要（写盘之后调用，免得下一轮扫描又解析一遍刚写的文件）。
/// 目前没有调用方：写入后文件的 mtime 本来就会变，下一次扫描自然会重新解析。
/// 需要时再把它接到各 adapter 的 `write()` 上。

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::ir::SessionSummary;
    use std::io::Write;

    fn summary(id: &str, title: &str) -> SessionSummary {
        SessionSummary {
            id: id.into(),
            runtime: "test".into(),
            title: Some(title.into()),
            cwd: None,
            updated_at: Some(1),
            message_count: 1,
            size_bytes: 1,
        }
    }

    #[test]
    fn serves_only_when_stamp_matches() {
        let dir = std::env::temp_dir().join(format!("index-cache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.jsonl");
        std::fs::write(&file, b"hello").unwrap();

        let first = stamp(&file).unwrap();
        assert!(lookup("test", &file, first).is_none(), "没存过就不该命中");

        store("test", &file, first, summary("a", "标题一"));
        let hit = lookup("test", &file, first).unwrap();
        assert_eq!(hit.title.as_deref(), Some("标题一"));

        // 内容变了（戳记不同）→ 必须失效
        let mut f = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
        f.write_all(b" more").unwrap();
        f.sync_all().unwrap();
        let second = stamp(&file).unwrap();
        assert_ne!(first, second, "改动后戳记应当变化");
        assert!(lookup("test", &file, second).is_none(), "戳记变了就不该复用旧摘要");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
