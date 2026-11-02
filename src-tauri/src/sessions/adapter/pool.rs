//! 中心池：把会话以**统一 IR**存一份在本地，作为跨客户端的交换与归档区。
//!
//! 刻意不做成「唯一真相」：客户端读不了我们的格式，池子只能当**中转与归档**——
//! 从任意 runtime 迁进来（`read` 那边出 IR，这里落盘），再迁去任意 runtime。
//! 因为每个 adapter 都走同一份 IR，所以池子不需要认识任何一家的原生格式。
//!
//! 存法：一个会话一个 `<uuid>.json`（`Session` 的序列化），写盘仍是 tmp + rename。
//! 与其它 adapter 不同的是：**工具调用不丢**——IR 里本来就带 ToolUse/ToolResult，
//! 池子是自留地，没有理由降级。
use super::{now_ms, user_home, Adapter, WriteResult};
use crate::sessions::ir::{Session, SessionSummary};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct Pool;

pub fn home() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("NIMBUS_POOL_DIR").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(root));
    }
    user_home().ok().map(|h| h.join(".nimbusdesk").join("sessions"))
}

fn entry_path(root: &Path, id: &str) -> PathBuf {
    // id 只可能是我们自己生成的 uuid，但入口仍挡住路径分隔符，别让人拼出 ../..
    let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    root.join(format!("{safe}.json"))
}

/// 从池子里的一份快照里读出列表摘要（不解析整份事件）。
fn summary_of(path: &Path) -> Option<SessionSummary> {
    let text = fs::read_to_string(path).ok()?;
    let session: Session = serde_json::from_str(&text).ok()?;
    let meta = fs::metadata(path).ok();
    let updated = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .or(session.updated_at);
    Some(SessionSummary {
        id: path.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown").to_string(),
        runtime: "pool".into(),
        title: session.title.clone(),
        cwd: session.cwd.clone(),
        updated_at: updated,
        message_count: session.events.len(),
        size_bytes: meta.as_ref().map(|m| m.len()).unwrap_or(0),
    })
}

/// 列表：扫 `root/*.json`（抽出来是为了测试能指定根目录）。
fn discover_root(root: &Path) -> Vec<SessionSummary> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Some(summary) = summary_of(&path) {
            out.push(summary);
        }
    }
    out.sort_by(|a, b| b.updated_at.unwrap_or(0).cmp(&a.updated_at.unwrap_or(0)));
    out
}

fn read_root(root: &Path, id: &str) -> Result<Session, String> {
    let path = entry_path(root, id);
    let text = fs::read_to_string(&path).map_err(|e| format!("读取池中会话 {id} 失败: {e}"))?;
    serde_json::from_str::<Session>(&text).map_err(|e| format!("解析池中会话 {id} 失败: {e}"))
}

fn write_root(root: &Path, session: &Session, cwd: &str) -> Result<WriteResult, String> {
    fs::create_dir_all(root).map_err(|e| format!("创建中心池目录失败: {e}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let file = entry_path(root, &id);
    let tmp = root.join(format!(".{id}.json.tmp"));

    let mut snapshot = session.clone();
    snapshot.id = id.clone();
    snapshot.runtime = "pool".into();
    if snapshot.cwd.is_none() {
        snapshot.cwd = Some(cwd.to_string());
    }
    if snapshot.updated_at.is_none() {
        snapshot.updated_at = Some(now_ms());
    }

    {
        let text = serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?;
        let mut f = fs::File::create(&tmp).map_err(|e| format!("创建 {} 失败: {e}", tmp.display()))?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &file).map_err(|e| format!("写入中心池失败: {e}"))?;

    Ok(WriteResult {
        id,
        // 池子里的会话不能直接 resume，给的是「从这里迁去哪一家」的提示
        resume_command: None,
        path: Some(file.to_string_lossy().into_owned()),
        dropped: Vec::new(),
    })
}

impl Adapter for Pool {
    fn id(&self) -> &'static str { "pool" }
    fn label(&self) -> &'static str { "中心池" }
    fn home(&self) -> Option<PathBuf> { home() }

    fn discover(&self) -> Result<Vec<SessionSummary>, String> {
        Ok(discover_root(&home().ok_or("无法解析中心池目录")?))
    }

    fn read(&self, id: &str) -> Result<Session, String> {
        read_root(&home().ok_or("无法解析中心池目录")?, id)
    }

    fn write(&self, session: &Session, cwd: &str) -> Result<WriteResult, String> {
        write_root(&home().ok_or("无法解析中心池目录")?, session, cwd)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::ir::{Event, EventKind};

    fn sample() -> Session {
        Session {
            id: "source-session".into(),
            runtime: "codex".into(),
            cwd: Some("E:\\01-Desktop\\pi".into()),
            title: Some("把这段抽出来".into()),
            updated_at: Some(1_700_000_000_000),
            events: vec![
                Event { kind: EventKind::UserPrompt, text: Some("把这段抽出来".into()), timestamp: None, tool: None, paths: vec![] },
                Event { kind: EventKind::ToolUse, text: Some("{\"cmd\":\"ls\"}".into()), timestamp: None, tool: Some("shell".into()), paths: vec![] },
                Event { kind: EventKind::AssistantReply, text: Some("好了".into()), timestamp: None, tool: None, paths: vec![] },
            ],
        }
    }

    fn with_pool<T>(f: impl FnOnce(&Path) -> T) -> T {
        let dir = std::env::temp_dir().join(format!("pool-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let out = f(&dir);
        let _ = fs::remove_dir_all(&dir);
        out
    }

    #[test]
    fn round_trips_ir_without_dropping_tools() {
        with_pool(|dir| {
            let written = write_root(dir, &sample(), "E:\\01-Desktop\\pi").unwrap();
            let back = read_root(dir, &written.id).unwrap();
            assert_eq!(back.runtime, "pool");
            assert_eq!(back.title.as_deref(), Some("把这段抽出来"));
            assert_eq!(back.cwd.as_deref(), Some("E:\\01-Desktop\\pi"));
            assert_eq!(back.events.len(), 3, "工具事件不该被丢掉");
            assert!(back.events.iter().any(|e| e.kind == EventKind::ToolUse));
        });
    }

    #[test]
    fn lists_pool_entries_and_blocks_path_traversal() {
        with_pool(|dir| {
            write_root(dir, &sample(), "E:\\01-Desktop\\pi").unwrap();
            let listed = discover_root(dir);
            assert_eq!(listed.len(), 1);
            assert_eq!(listed[0].runtime, "pool");
            assert_eq!(listed[0].message_count, 3);

            // 入口处把分隔符过滤掉，拼不出目录外的路径
            let escaped = entry_path(dir, "../evil");
            assert_eq!(escaped.parent(), Some(dir));
            assert!(read_root(dir, "../evil").is_err());
        });
    }

    #[test]
    fn missing_directory_is_an_empty_list_not_an_error() {
        let missing = std::env::temp_dir().join(format!("pool-absent-{}", uuid::Uuid::new_v4()));
        assert!(discover_root(&missing).is_empty());
    }
}
