//! WorkBuddy（腾讯 AI Agent 办公助手）会话适配器。
//!
//! 原生格式：`~/.workbuddy/projects/<slug>/<uuid>.jsonl`，Claude Code 风格
//! 的逐行事件（message / reasoning / tool_use / file-history-snapshot）。
//! 桌面任务列表元数据在 `workbuddy.db`；本适配器 v1 只做 JSONL 读写，
//! GUI 注册另行验证（AgentGit 的同款适配器也标注了这一边界）。
use super::{now_ms, user_home, Adapter, WriteResult};
use crate::sessions::ir::{Event, EventKind, Session, SessionSummary};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct WorkBuddy;

pub fn home() -> Option<PathBuf> {
    for key in ["WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR"] {
        if let Some(root) = std::env::var_os(key).filter(|v| !v.is_empty()) {
            return Some(PathBuf::from(root));
        }
    }
    let base = user_home().ok()?;
    let primary = base.join(".workbuddy");
    if primary.join("projects").exists() {
        return Some(primary);
    }
    let alt = base.join(".workbuddy-ai");
    if alt.join("projects").exists() {
        return Some(alt);
    }
    Some(primary)
}

fn slug_for(cwd: &str) -> String {
    let mut body = String::new();
    let mut last_dash = false;
    for ch in cwd.chars() {
        if ch.is_ascii_alphanumeric() {
            body.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            body.push('-');
            last_dash = true;
        }
    }
    body.trim_matches('-').to_string()
}

fn content_text(value: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(items) = value.as_array() {
        for item in items {
            let ty = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if matches!(ty, "input_text" | "output_text" | "text") {
                if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                    if !text.trim().is_empty() {
                        parts.push(text.to_string());
                    }
                }
            }
        }
    }
    parts.join("\n")
}

fn is_injected(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<system-reminder") || t.starts_with("<user_info>") || t.starts_with("<project_context>")
}

/// WorkBuddy 把真实用户输入包在 `<user_query>...</user_query>` 里，外面再套
/// `<system-reminder>` 等注入内容。取内层 query；纯注入消息才丢弃。
fn user_prompt_text(text: &str) -> Option<String> {
    let mut parts = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("<user_query>") {
        let after = &rest[start + "<user_query>".len()..];
        let Some(end) = after.find("</user_query>") else { break; };
        let inner = after[..end].trim();
        if !inner.is_empty() {
            parts.push(inner.to_string());
        }
        rest = &after[end + "</user_query>".len()..];
    }
    if !parts.is_empty() {
        return Some(parts.join("\n"));
    }
    if is_injected(text) {
        return None;
    }
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn parse_file(path: &Path) -> Result<(Session, Option<String>, usize), String> {
    let text = fs::read_to_string(path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown").to_string();
    let mut session = Session { id, runtime: "workbuddy".into(), cwd: None, title: None, updated_at: None, events: Vec::new() };
    let mut count = 0usize;
    let mut first_user: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue; };
        count += 1;
        if session.cwd.is_none() {
            if let Some(cwd) = row.get("cwd").and_then(|v| v.as_str()) {
                session.cwd = Some(cwd.to_string());
            }
        }
        let ty = row.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let ts = row.get("timestamp").and_then(|v| v.as_i64()).map(|ms| ms.to_string());
        match ty {
            "message" => {
                let role = row.get("role").and_then(|v| v.as_str()).unwrap_or("");
                let text = content_text(row.get("content").unwrap_or(&Value::Null));
                if text.trim().is_empty() { continue; }
                if role == "user" {
                    let Some(prompt) = user_prompt_text(&text) else { continue; };
                    if first_user.is_none() { first_user = Some(prompt.clone()); }
                    session.events.push(Event { kind: EventKind::UserPrompt, text: Some(prompt), timestamp: ts, tool: None, paths: vec![] });
                } else if role == "assistant" {
                    session.events.push(Event { kind: EventKind::AssistantReply, text: Some(text), timestamp: ts, tool: None, paths: vec![] });
                }
            }
            "tool_use" | "tool_call" => {
                let name = row.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                let args = row.get("input").map(|v| v.to_string()).unwrap_or_default();
                session.events.push(Event { kind: EventKind::ToolUse, text: Some(args), timestamp: ts, tool: Some(name.to_string()), paths: vec![] });
            }
            "tool_result" => {
                let text = row.get("content").map(|v| v.to_string()).unwrap_or_default();
                session.events.push(Event { kind: EventKind::ToolResult, text: Some(text), timestamp: ts, tool: None, paths: vec![] });
            }
            _ => {}
        }
    }
    session.title = first_user.as_deref().map(|s| {
        let s = s.replace('\n', " ");
        s.chars().take(60).collect::<String>()
    });
    Ok((session, first_user, count))
}

impl Adapter for WorkBuddy {
    fn id(&self) -> &'static str { "workbuddy" }
    fn label(&self) -> &'static str { "WorkBuddy" }
    fn home(&self) -> Option<PathBuf> { home() }

    fn discover(&self) -> Result<Vec<SessionSummary>, String> {
        let root = home().ok_or("无法解析 WorkBuddy 主目录")?.join("projects");
        let mut out = Vec::new();
        if !root.exists() { return Ok(out); }
        for project in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
            if !project.path().is_dir() { continue; }
            for file in fs::read_dir(project.path()).map_err(|e| e.to_string())?.flatten() {
                let path = file.path();
                if path.extension().and_then(|s| s.to_str()) != Some("jsonl") { continue; }
                let Some(current) = crate::sessions::index::stamp(&path) else { continue };
                if let Some(hit) = crate::sessions::index::lookup("workbuddy", &path, current) {
                    out.push(hit);
                    continue;
                }
                let size = current.size;
                let parsed = if size <= 32 * 1024 * 1024 { parse_file(&path).ok() } else { None };
                let (title, cwd, count) = parsed.map(|(s, _, c)| (s.title, s.cwd, c)).unwrap_or((None, None, 0));
                let summary = SessionSummary {
                    id: path.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown").to_string(),
                    runtime: "workbuddy".into(),
                    title,
                    cwd,
                    updated_at: Some(current.mtime_ms),
                    message_count: count,
                    size_bytes: size,
                };
                crate::sessions::index::store("workbuddy", &path, current, summary.clone());
                out.push(summary);
            }
        }
        out.sort_by(|a, b| b.updated_at.unwrap_or(0).cmp(&a.updated_at.unwrap_or(0)));
        Ok(out)
    }

    fn read(&self, id: &str) -> Result<Session, String> {
        let root = home().ok_or("无法解析 WorkBuddy 主目录")?.join("projects");
        for project in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
            let path = project.path().join(format!("{id}.jsonl"));
            if path.exists() {
                let (session, _, _) = parse_file(&path)?;
                return Ok(session);
            }
        }
        Err(format!("找不到 WorkBuddy 会话 {id}"))
    }

    fn write(&self, session: &Session, cwd: &str) -> Result<WriteResult, String> {
        let root = home().ok_or("无法解析 WorkBuddy 主目录")?.join("projects");
        let id = uuid::Uuid::new_v4().to_string();
        let dir = root.join(slug_for(cwd));
        fs::create_dir_all(&dir).map_err(|e| format!("创建 WorkBuddy 项目目录失败: {e}"))?;
        let file = dir.join(format!("{id}.jsonl"));
        let tmp = dir.join(format!(".{id}.jsonl.tmp"));
        let now = now_ms();
        let mut parent: Option<String> = None;
        let mut dropped = Vec::new();
        {
            let mut f = fs::File::create(&tmp).map_err(|e| format!("创建 {} 失败: {e}", tmp.display()))?;
            for event in &session.events {
                let (role, content_type) = match event.kind {
                    EventKind::UserPrompt => ("user", "input_text"),
                    EventKind::AssistantReply => ("assistant", "output_text"),
                    EventKind::ToolUse | EventKind::ToolResult => {
                        dropped.push("工具调用（WorkBuddy JSONL 写入暂不保留）".into());
                        continue;
                    }
                    _ => continue,
                };
                let msg_id = uuid::Uuid::new_v4().to_string();
                let row = json!({
                    "id": msg_id,
                    "parentId": parent,
                    "timestamp": now,
                    "type": "message",
                    "role": role,
                    "content": [{"type": content_type, "text": event.text.clone().unwrap_or_default()}],
                    "sessionId": id,
                    "cwd": cwd,
                });
                f.write_all(serde_json::to_string(&row).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
                f.write_all(b"\n").map_err(|e| e.to_string())?;
                parent = Some(msg_id);
            }
            f.sync_all().map_err(|e| e.to_string())?;
        }
        fs::rename(&tmp, &file).map_err(|e| format!("发布 WorkBuddy 会话失败: {e}"))?;
        register_in_desktop_db(&id, cwd, session.title.as_deref())?;
        Ok(WriteResult { id: id.clone(), resume_command: Some(format!("workbuddy --resume {id}")), path: Some(file.to_string_lossy().into_owned()), dropped })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::ir::EventKind;
    use crate::sessions::TEST_ENV_LOCK;

    #[test]
    fn slug_is_lowercase_and_collapsed() {
        assert_eq!(slug_for("C:\\Users\\dz\\WorkBuddy\\2026-05-31"), "c-users-dz-workbuddy-2026-05-31");
    }

    #[test]
    fn extracts_user_query_from_injected_wrapper() {
        let text = "<system-reminder><user_info>x</user_info><user_query>修一下登录页</user_query></system-reminder>";
        assert_eq!(user_prompt_text(text).as_deref(), Some("修一下登录页"));
        assert_eq!(user_prompt_text("<system-reminder>only context</system-reminder>"), None);
        assert_eq!(user_prompt_text("普通输入").as_deref(), Some("普通输入"));
    }

    #[test]
    fn parses_wrapped_user_query_from_jsonl() {
        let tmp = std::env::temp_dir().join(format!("nimbus-wb-wrap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("s.jsonl");
        let line = serde_json::json!({
            "type": "message",
            "role": "user",
            "content": [{"type": "text", "text": "<system-reminder><user_query>修一下登录页</user_query></system-reminder>"}]
        });
        std::fs::write(&file, format!("{}\n", line)).unwrap();
        let (session, first, _) = parse_file(&file).unwrap();
        assert_eq!(first.as_deref(), Some("修一下登录页"));
        assert_eq!(session.events.len(), 1);
        assert_eq!(session.events[0].text.as_deref(), Some("修一下登录页"));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn roundtrip_writes_and_reads_jsonl() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!("nimbus-wb-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        unsafe { std::env::set_var("WORKBUDDY_CONFIG_DIR", &tmp); }
        let session = Session {
            id: "src".into(),
            runtime: "workbuddy".into(),
            cwd: Some(tmp.to_string_lossy().into_owned()),
            title: Some("hello".into()),
            updated_at: None,
            events: vec![
                Event { kind: EventKind::UserPrompt, text: Some("你好".into()), timestamp: None, tool: None, paths: vec![] },
                Event { kind: EventKind::AssistantReply, text: Some("世界".into()), timestamp: None, tool: None, paths: vec![] },
            ],
        };
        let result = WorkBuddy.write(&session, &session.cwd.clone().unwrap()).unwrap();
        let read = WorkBuddy.read(&result.id).unwrap();
        assert!(read.events.iter().any(|e| e.kind == EventKind::UserPrompt && e.text.as_deref() == Some("你好")));
        assert!(read.events.iter().any(|e| e.kind == EventKind::AssistantReply && e.text.as_deref() == Some("世界")));
        unsafe { std::env::remove_var("WORKBUDDY_CONFIG_DIR"); }
        std::fs::remove_dir_all(&tmp).ok();
    }
}

/// 把新会话登记进 WorkBuddy 桌面端的 sessions 表，让它出现在任务列表。
/// 表不存在（CLI-only 安装）时静默跳过；既有行永不改动。
fn register_in_desktop_db(id: &str, cwd: &str, title: Option<&str>) -> Result<(), String> {
    let Some(home) = home() else { return Ok(()); };
    let db_path = home.join("workbuddy.db");
    if !db_path.is_file() {
        return Ok(());
    }
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| format!("打开 workbuddy.db 失败: {e}"))?;
    let has_sessions: bool = conn
        .query_row("select count(*) from sqlite_master where type='table' and name='sessions'", [], |row| row.get::<_, i64>(0))
        .map(|n| n > 0)
        .unwrap_or(false);
    if !has_sessions {
        return Ok(());
    }
    let user_id: String = conn
        .query_row("select user_id from sessions order by updated_at desc limit 1", [], |row| row.get(0))
        .unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().timestamp_millis();
    let title = title.unwrap_or("云台导入");
    conn.execute(
        "insert or ignore into sessions (id,cwd,user_id,title,status,created_at,updated_at,is_playground,source_mode,mode) values (?1,?2,?3,?4,'completed',?5,?5,1,'craft','craft')",
        rusqlite::params![id, cwd, user_id, title, now],
    )
    .map_err(|e| format!("登记 WorkBuddy 任务失败: {e}"))?;
    Ok(())
}
