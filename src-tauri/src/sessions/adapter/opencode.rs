//! OpenCode（sst/opencode，v2）会话适配器。
//!
//! 读：`~/.local/share/opencode/opencode.db`（SQLite，WAL）的
//! `session` / `message` / `part` 三表；绝不整库复制。
//! 写：生成 OpenCode 官方 export JSON，调用 `opencode session import`；
//! import 是 insert-ignore（幂等），所有 id 重铸。
use super::{now_ms, user_home, Adapter, WriteResult};
use crate::sessions::ir::{Event, EventKind, Session, SessionSummary};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub struct OpenCode;

pub fn db_path() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("OPENCODE_DATA_DIR").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(root).join("opencode.db"));
    }
    let home = user_home().ok()?;
    let candidates = [
        home.join(".local").join("share").join("opencode").join("opencode.db"),
        home.join("Library").join("Application Support").join("opencode").join("opencode.db"),
        home.join("AppData").join("Local").join("opencode").join("opencode.db"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

fn open_db() -> Result<Connection, String> {
    let path = db_path().ok_or("找不到 opencode.db")?;
    Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("打开 {} 失败: {e}", path.display()))
}

fn text_parts(value: &Value) -> String {
    let mut out = Vec::new();
    if let Some(items) = value.as_array() {
        for item in items {
            if item.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                    if !text.trim().is_empty() {
                        out.push(text.to_string());
                    }
                }
            }
        }
    }
    out.join("\n")
}

fn row_text(value: Option<String>) -> String {
    value.map(|s| s.replace('\u{0000}', "")).unwrap_or_default()
}

/// Read a session stored in the v2 tables (`session_v2` + `session_message`).
/// The v2 API writes these tables even when the legacy `session` table exists,
/// so an API-imported target must be readable without the legacy mirror.
fn read_v2(db: &Connection, id: &str) -> Result<Session, String> {
    let (title, directory): (String, String) = db
        .query_row(
            "select coalesce(title,''), coalesce(directory,'') from session_v2 where id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("找不到 OpenCode v2 会话 {id}: {e}"))?;
    let mut stmt = db
        .prepare("select type, data from session_message where session_id=?1 order by seq")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut events = Vec::new();
    for (kind, data) in rows.flatten() {
        let parsed: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
        let text = match kind.as_str() {
            "user" => parsed.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
            "assistant" => parsed
                .get("content")
                .and_then(Value::as_array)
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|block| {
                            (block.get("type").and_then(Value::as_str) == Some("text"))
                                .then(|| block.get("text").and_then(Value::as_str).unwrap_or(""))
                                .filter(|text| !text.trim().is_empty())
                                .map(str::to_string)
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default(),
            _ => continue,
        };
        let kind = if kind == "assistant" { EventKind::AssistantReply } else { EventKind::UserPrompt };
        if !text.trim().is_empty() {
            events.push(Event { kind, text: Some(text), timestamp: None, tool: None, paths: vec![] });
        }
    }
    Ok(Session {
        id: id.to_string(),
        runtime: "opencode".into(),
        cwd: if directory.trim().is_empty() { None } else { Some(directory) },
        title: if title.trim().is_empty() { None } else { Some(title) },
        updated_at: None,
        events,
    })
}

/// Fallback for the broken v2.1.4 CLI `session import`: boot the local API
/// server and use `/api/experimental/session/import`, which accepts the same
/// projected transcript without going through the CLI's bad request path.
fn api_import(session: &Session, sid: &str, cwd: &str) -> Result<(), String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    let log = std::env::temp_dir().join(format!("nimbus-opencode-serve-{sid}.log"));
    let log_file = fs::File::create(&log).map_err(|e| e.to_string())?;
    let mut command = Command::new("opencode");
    command
        .args(["serve", "--hostname", "127.0.0.1", "--port", &port.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::null());
    if let Some(root) = std::env::var_os("OPENCODE_DATA_DIR").filter(|value| !value.is_empty()) {
        if let Some(parent) = Path::new(&root).parent() {
            command.env("XDG_DATA_HOME", parent);
        }
    }
    let mut child = command.spawn().map_err(|e| format!("启动 opencode serve 失败: {e}"))?;
    let result = (|| -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(12);
        let mut password = None;
        while Instant::now() < deadline {
            if let Ok(text) = fs::read_to_string(&log) {
                if let Some(line) = text.lines().find(|line| line.contains("password")) {
                    password = line.split_whitespace().last().map(str::to_string);
                    if password.is_some() {
                        break;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let password = password.ok_or("opencode serve 没有输出密码")?;
        let now = now_ms();
        let messages: Vec<Value> = session
            .events
            .iter()
            .filter_map(|event| {
                let text = event.text.clone().unwrap_or_default();
                match event.kind {
                    EventKind::UserPrompt => Some(json!({
                        "id": format!("msg_{}", uuid::Uuid::new_v4().simple()),
                        "time": {"created": now},
                        "text": text,
                        "type": "user"
                    })),
                    EventKind::AssistantReply => Some(json!({
                        "id": format!("msg_{}", uuid::Uuid::new_v4().simple()),
                        "time": {"created": now, "completed": now},
                        "type": "assistant",
                        "agent": "build",
                        "model": {"id": "imported", "providerID": "nimbusdesk", "variant": "default"},
                        "content": [{"type": "text", "text": text}],
                        "finish": "stop",
                        "cost": 0,
                        "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}}
                    })),
                    _ => None,
                }
            })
            .collect();
        if messages.is_empty() {
            return Err("没有可导入的消息".into());
        }
        let body = json!({
            "info": {
                "id": sid,
                "projectID": "global",
                "agent": "build",
                "model": {"id": "imported", "providerID": "nimbusdesk", "variant": "default"},
                "cost": 0,
                "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}},
                "time": {"created": now, "updated": now},
                "title": session.title.clone().unwrap_or_else(|| "云台导入".into()),
                "location": {"directory": cwd}
            },
            "messages": messages
        });
        let response = reqwest::blocking::Client::new()
            .post(format!("http://127.0.0.1:{port}/api/experimental/session/import"))
            .basic_auth("opencode", Some(password))
            .json(&body)
            .send()
            .map_err(|e| format!("opencode API 请求失败: {e}"))?;
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().unwrap_or_default();
            return Err(format!("opencode API 导入失败 {status}: {text}"));
        }
        Ok(())
    })();
    let _ = child.kill();
    let _ = child.wait();
    let _ = fs::remove_file(&log);
    result
}

impl Adapter for OpenCode {
    fn id(&self) -> &'static str { "opencode" }
    fn label(&self) -> &'static str { "OpenCode" }
    fn home(&self) -> Option<PathBuf> { db_path().map(|p| p.parent().unwrap_or(&p).to_path_buf()) }

    fn discover(&self) -> Result<Vec<SessionSummary>, String> {
        let db = open_db()?;
        let mut stmt = db
            .prepare("select id, coalesce(title,''), coalesce(directory,''), time_updated, parent_id from session order by time_updated desc limit 300")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let title: String = row.get(1)?;
                let directory: String = row.get(2)?;
                let updated: i64 = row.get(3)?;
                let parent: Option<String> = row.get(4)?;
                Ok((id, title, directory, updated, parent))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows.flatten() {
            let (id, title, directory, updated, parent) = row;
            if parent.is_some() {
                continue;
            }
            let count: i64 = db
                .query_row("select count(*) from message where session_id=?1", [&id], |r| r.get(0))
                .unwrap_or(0);
            out.push(SessionSummary {
                id,
                runtime: "opencode".into(),
                title: if title.trim().is_empty() { None } else { Some(title) },
                cwd: if directory.trim().is_empty() { None } else { Some(directory) },
                updated_at: Some(updated),
                message_count: count as usize,
                size_bytes: 0,
            });
        }
        if let Ok(mut stmt) = db.prepare(
            "select v.id, coalesce(v.title,''), coalesce(v.directory,''), v.time_updated \
             from session_v2 v left join session s on s.id = v.id \
             where s.id is null and v.parent_id is null order by v.time_updated desc limit 300",
        ) {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            }) {
                for row in rows.flatten() {
                    let (id, title, directory, updated) = row;
                    let count: i64 = db
                        .query_row("select count(*) from session_message where session_id=?1", [&id], |r| r.get(0))
                        .unwrap_or(0);
                    out.push(SessionSummary {
                        id,
                        runtime: "opencode".into(),
                        title: if title.trim().is_empty() { None } else { Some(title) },
                        cwd: if directory.trim().is_empty() { None } else { Some(directory) },
                        updated_at: Some(updated),
                        message_count: count as usize,
                        size_bytes: 0,
                    });
                }
            }
        }
        Ok(out)
    }

    fn read(&self, id: &str) -> Result<Session, String> {
        let db = open_db()?;
        let meta = db.query_row(
            "select coalesce(title,''), coalesce(directory,'') from session where id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        );
        let (title, directory): (String, String) = match meta {
            Ok(value) => value,
            Err(_) => return read_v2(&db, id),
        };
        let mut stmt = db
            .prepare("select id, data from message where session_id=?1 order by time_created, id")
            .map_err(|e| e.to_string())?;
        let messages = stmt
            .query_map([id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .flatten()
            .collect::<Vec<_>>();
        let mut events = Vec::new();
        for (msg_id, data) in messages {
            let parsed: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
            let role = parsed.get("role").and_then(|v| v.as_str()).unwrap_or("");
            let ts = parsed.pointer("/time/created").and_then(|v| v.as_i64()).map(|ms| ms.to_string());
            let mut parts_stmt = db
                .prepare("select data from part where message_id=?1 order by time_created, id")
                .map_err(|e| e.to_string())?;
            let parts = parts_stmt
                .query_map([&msg_id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .flatten()
                .collect::<Vec<_>>();
            let mut texts = Vec::new();
            for part in parts {
                let Ok(p) = serde_json::from_str::<Value>(&part) else { continue; };
                match p.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                    "text" => {
                        let t = row_text(p.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()));
                        if !t.trim().is_empty() { texts.push(t); }
                    }
                    "tool" => {
                        let name = p.get("tool").and_then(|v| v.as_str()).unwrap_or("tool");
                        let args = p.pointer("/state/input").map(|v| v.to_string()).unwrap_or_default();
                        events.push(Event { kind: EventKind::ToolUse, text: Some(args), timestamp: ts.clone(), tool: Some(name.to_string()), paths: vec![] });
                        let output = p.pointer("/state/output").map(|v| v.to_string()).unwrap_or_default();
                        if !output.is_empty() {
                            events.push(Event { kind: EventKind::ToolResult, text: Some(output), timestamp: ts.clone(), tool: None, paths: vec![] });
                        }
                    }
                    _ => {}
                }
            }
            if !texts.is_empty() {
                let kind = if role == "assistant" { EventKind::AssistantReply } else if role == "user" { EventKind::UserPrompt } else { EventKind::Other };
                events.push(Event { kind, text: Some(texts.join("\n")), timestamp: ts, tool: None, paths: vec![] });
            }
        }
        if events.is_empty() {
            if let Ok(session) = read_v2(&db, id) {
                if !session.events.is_empty() {
                    return Ok(session);
                }
            }
        }
        Ok(Session {
            id: id.to_string(),
            runtime: "opencode".into(),
            cwd: if directory.trim().is_empty() { None } else { Some(directory) },
            title: if title.trim().is_empty() { None } else { Some(title) },
            updated_at: None,
            events,
        })
    }

    fn write(&self, session: &Session, cwd: &str) -> Result<WriteResult, String> {
        let sid = format!("ses_{}", uuid::Uuid::new_v4().simple());
        let mut messages = Vec::new();
        let mut dropped = Vec::new();
        let mut i = 0usize;
        for event in &session.events {
            let role = match event.kind {
                EventKind::UserPrompt => "user",
                EventKind::AssistantReply => "assistant",
                EventKind::ToolUse | EventKind::ToolResult => {
                    dropped.push("工具调用（OpenCode import 暂不保留）".into());
                    continue;
                }
                _ => continue,
            };
            i += 1;
            let msg_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
            let ts = now_ms() + i as i64;
            messages.push(json!({
                "id": msg_id,
                "time": {"created": ts},
                "text": event.text.clone().unwrap_or_default(),
                "type": role
            }));
        }
        let export = json!({
            "info": {
                "id": sid,
                "projectID": "global",
                "agent": "build",
                "model": {"id": "imported", "providerID": "nimbusdesk", "variant": "default"},
                "cost": 0,
                "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}},
                "time": {"created": now_ms(), "updated": now_ms()},
                "title": session.title.clone().unwrap_or_else(|| "云台导入".into()),
                "location": {"directory": cwd}
            },
            "messages": messages
        });
        let tmp_dir = std::env::temp_dir().join("nimbusdesk-opencode-import");
        fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
        let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(7 * 24 * 60 * 60);
        if let Ok(entries) = fs::read_dir(&tmp_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|value| value.to_str()) == Some("json")
                    && entry.metadata().ok().and_then(|meta| meta.modified().ok()).is_some_and(|time| time < cutoff)
                {
                    let _ = fs::remove_file(path);
                }
            }
        }
        let file = tmp_dir.join(format!("{sid}.json"));
        fs::write(&file, serde_json::to_vec_pretty(&export).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let mut cmd = Command::new("opencode");
        cmd.args(["session", "import", &file.to_string_lossy()])
            .current_dir(Path::new(cwd));
        if let Some(root) = std::env::var_os("OPENCODE_DATA_DIR").filter(|value| !value.is_empty()) {
            if let Some(parent) = Path::new(&root).parent() {
                cmd.env("XDG_DATA_HOME", parent);
            }
        }
        let output = cmd.output().map_err(|e| format!("调用 opencode 失败: {e}"))?;
        let cli_error = if output.status.success() {
            let written = open_db()
                .and_then(|db| {
                    db.query_row(
                        "select exists(select 1 from session where id = ?1)",
                        [&sid],
                        |row| row.get::<_, bool>(0),
                    )
                    .map_err(|e| e.to_string())
                })
                .unwrap_or(false);
            if written {
                None
            } else {
                Some(format!("opencode 报告成功但没有写入会话 {sid}"))
            }
        } else {
            Some(format!(
                "opencode session import 失败: {}{}",
                String::from_utf8_lossy(&output.stderr),
                String::from_utf8_lossy(&output.stdout)
            ))
        };
        if let Some(cli_error) = cli_error {
            api_import(session, &sid, cwd).map_err(|api_error| {
                format!(
                    "{cli_error}；API fallback 也失败: {api_error}（导出文件保留在 {}）",
                    file.display()
                )
            })?;
        }
        fs::remove_file(&file).ok();
        Ok(WriteResult {
            id: sid.clone(),
            resume_command: Some(format!("opencode --session {sid}")),
            path: None,
            dropped,
        })
    }
}

#[cfg(test)]
mod write_tests {
    use super::*;
    use crate::sessions::ir::EventKind;
    use crate::sessions::TEST_ENV_LOCK;

    #[test]
    fn api_import_writes_a_readable_session() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!("nimbus-oc-write-{}", uuid::Uuid::new_v4()));
        let data = tmp.join("opencode");
        std::fs::create_dir_all(&data).unwrap();
        unsafe { std::env::set_var("OPENCODE_DATA_DIR", &data); }
        let session = Session {
            id: "src".into(),
            runtime: "opencode".into(),
            cwd: Some(tmp.to_string_lossy().into_owned()),
            title: Some("api write".into()),
            updated_at: None,
            events: vec![
                Event { kind: EventKind::UserPrompt, text: Some("hello".into()), timestamp: None, tool: None, paths: vec![] },
                Event { kind: EventKind::AssistantReply, text: Some("world".into()), timestamp: None, tool: None, paths: vec![] },
            ],
        };
        let result = OpenCode.write(&session, &session.cwd.clone().unwrap()).unwrap();
        let read = OpenCode.read(&result.id).unwrap();
        assert!(read.events.iter().any(|event| event.kind == EventKind::UserPrompt));
        assert!(read.events.iter().any(|event| event.kind == EventKind::AssistantReply));
        unsafe { std::env::remove_var("OPENCODE_DATA_DIR"); }
        std::fs::remove_dir_all(&tmp).ok();
    }
}
