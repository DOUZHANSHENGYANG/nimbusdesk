//! DeepSeek Harness（DSH）会话适配器。
//!
//! 读：`~/.dsh/sessions/<encoded-cwd>/session-<uuid>/session*.jsonl[.zstd]`，
//! 多帧 zstd 必须按帧魔数切片逐帧解压（只解第一帧会丢事件）。
//! 写：生成 v0 raw JSONL 的 zstd 两帧（header + events），并登记
//! `~/.dsh/storages/workspace.json`；原会话只读。
use super::{now_ms, user_home, Adapter, WriteResult};
use crate::sessions::ir::{Event, EventKind, Session, SessionSummary};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct Dsh;

const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];

pub fn home() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("DSH_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(root));
    }
    user_home().ok().map(|h| h.join(".dsh"))
}

/// DSH 的可读目录名：非 ASCII 字符写成 `~XXXX`，分隔符折成 `-`。
pub fn cwd_slug(cwd: &str) -> String {
    let mut body = String::new();
    let mut last_dash = false;
    for ch in cwd.chars() {
        if ch.is_ascii_alphanumeric() {
            body.push(ch);
            last_dash = false;
        } else if (ch as u32) > 0x7f {
            body.push_str(&format!("~{:04X}", ch as u32));
            last_dash = false;
        } else if !last_dash {
            body.push('-');
            last_dash = true;
        }
    }
    let body = body.trim_matches('-').to_string();
    format!("--{body}--")
}

pub(crate) fn decode_zstd_frames(bytes: &[u8]) -> Result<Vec<u8>, String> {
    // 优先让 zstd crate 自己处理 concatenated frames；失败再按帧魔数切片兜底。
    if bytes.starts_with(&ZSTD_MAGIC) {
        if let Ok(decoded) = zstd::decode_all(bytes) {
            return Ok(decoded);
        }
    }
    let mut out = Vec::new();
    let mut start = None;
    let mut i = 0usize;
    while i + 4 <= bytes.len() {
        if bytes[i..i + 4] == ZSTD_MAGIC {
            if let Some(prev) = start {
                if let Ok(frame) = zstd::decode_all(&bytes[prev..i]) {
                    out.extend_from_slice(&frame);
                }
            }
            start = Some(i);
        }
        i += 1;
    }
    if let Some(prev) = start {
        if let Ok(frame) = zstd::decode_all(&bytes[prev..]) {
            out.extend_from_slice(&frame);
        }
    }
    if out.is_empty() {
        return Err("zstd 解压失败：没有可识别的帧".into());
    }
    Ok(out)
}

fn read_session_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    let raw = if path.extension().and_then(|s| s.to_str()) == Some("zstd") {
        decode_zstd_frames(&bytes)?
    } else {
        bytes
    };
    Ok(String::from_utf8_lossy(&raw).into_owned())
}

fn newest_session_file(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(u32, PathBuf)> = None;
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let version = if name == "session.jsonl" || name == "session.jsonl.zstd" {
            0
        } else if let Some(rest) = name.strip_prefix("session.v") {
            rest.split('.').next().and_then(|n| n.parse::<u32>().ok()).unwrap_or(0)
        } else {
            continue;
        };
        if !(name.ends_with(".jsonl") || name.ends_with(".jsonl.zstd")) {
            continue;
        }
        if best.as_ref().map(|(v, _)| version >= *v).unwrap_or(true) {
            best = Some((version, entry.path()));
        }
    }
    best.map(|(_, p)| p)
}

fn text_of(content: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(items) = content.as_array() {
        for item in items {
            if item.get("type").and_then(|v| v.as_str()) == Some("reasoning") {
                continue;
            }
            if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                if !text.trim().is_empty() {
                    parts.push(text.to_string());
                }
            }
        }
    } else if let Some(text) = content.as_str() {
        parts.push(text.to_string());
    }
    parts.join("\n")
}

fn parse_session(text: &str) -> Result<(Value, Vec<Event>, Option<String>), String> {
    let mut header: Option<Value> = None;
    let mut events = Vec::new();
    let mut title: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let row: Value = serde_json::from_str(line).map_err(|e| format!("DSH 行不是合法 JSON: {e}"))?;
        if header.is_none() && row.get("type").and_then(|v| v.as_str()) == Some("session") {
            header = Some(row);
            continue;
        }
        let kind = row.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let data = row.get("data").cloned().unwrap_or(Value::Null);
        let ts = row.get("time").and_then(|v| v.as_i64()).map(|ms| ms.to_string());
        match kind {
            "user/message" => {
                let source = data.pointer("/source/kind").and_then(|v| v.as_str()).unwrap_or("");
                let is_user = source.is_empty() || source == "user";
                if is_user {
                    let text = text_of(data.get("content").unwrap_or(&Value::Null));
                    if !text.trim().is_empty() {
                        events.push(Event { kind: EventKind::UserPrompt, text: Some(text), timestamp: ts, tool: None, paths: vec![] });
                    }
                }
            }
            "assistant/message" => {
                let text = text_of(data.pointer("/message/content").unwrap_or(&Value::Null));
                if !text.trim().is_empty() {
                    events.push(Event { kind: EventKind::AssistantReply, text: Some(text), timestamp: ts, tool: None, paths: vec![] });
                }
            }
            "tool/call" | "tool/code-dispatch" => {
                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                let args = data.get("arguments").map(|v| v.to_string()).unwrap_or_default();
                events.push(Event { kind: EventKind::ToolUse, text: Some(args), timestamp: ts, tool: Some(name.to_string()), paths: vec![] });
            }
            "tool/result" => {
                let text = data.get("error").map(|v| v.to_string()).or_else(|| {
                    let t = text_of(data.pointer("/message/content").unwrap_or(&Value::Null));
                    if t.is_empty() { None } else { Some(t) }
                });
                if let Some(text) = text {
                    events.push(Event { kind: EventKind::ToolResult, text: Some(text), timestamp: ts, tool: None, paths: vec![] });
                }
            }
            "compaction/summary" => {
                let text = data.get("summary").and_then(|v| v.as_str()).unwrap_or("").to_string();
                events.push(Event { kind: EventKind::CompactSummary, text: Some(text), timestamp: ts, tool: None, paths: vec![] });
            }
            "session/title" => {
                if let Some(t) = data.get("title").and_then(|v| v.as_str()) {
                    title = Some(t.to_string());
                }
            }
            "turn/end" => events.push(Event { kind: EventKind::TurnEnd, text: None, timestamp: ts, tool: None, paths: vec![] }),
            _ => {}
        }
    }
    header.ok_or_else(|| "DSH 会话缺少 header".to_string()).map(|h| (h, events, title))
}

impl Adapter for Dsh {
    fn id(&self) -> &'static str { "dsh" }
    fn label(&self) -> &'static str { "DeepSeek Harness" }
    fn home(&self) -> Option<PathBuf> { home() }

    fn discover(&self) -> Result<Vec<SessionSummary>, String> {
        let root = home().ok_or("无法解析 DSH 主目录")?.join("sessions");
        let mut out = Vec::new();
        if !root.exists() { return Ok(out); }
        for project in fs::read_dir(&root).map_err(|e| format!("读取 {} 失败: {e}", root.display()))?.flatten() {
            if !project.path().is_dir() { continue; }
            for session_dir in fs::read_dir(project.path()).map_err(|e| e.to_string())?.flatten() {
                let dir = session_dir.path();
                if !dir.is_dir() { continue; }
                let Some(file) = newest_session_file(&dir) else { continue; };
                let meta = fs::metadata(&file).ok();
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let updated = meta.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64);
                let text = if size <= 4 * 1024 * 1024 { read_session_file(&file).unwrap_or_default() } else { String::new() };
                let (cwd, title, count) = if text.is_empty() {
                    (None, None, 0)
                } else {
                    let (h, events, title) = parse_session(&text).unwrap_or((Value::Null, vec![], None));
                    (h.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string()), title, events.len())
                };
                out.push(SessionSummary {
                    id: dir.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                    runtime: "dsh".into(),
                    title,
                    cwd,
                    updated_at: updated,
                    message_count: count,
                    size_bytes: size,
                });
            }
        }
        out.sort_by(|a, b| b.updated_at.unwrap_or(0).cmp(&a.updated_at.unwrap_or(0)));
        Ok(out)
    }

    fn read(&self, id: &str) -> Result<Session, String> {
        let root = home().ok_or("无法解析 DSH 主目录")?.join("sessions");
        let mut found: Option<PathBuf> = None;
        for project in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
            let dir = project.path().join(id);
            if dir.is_dir() { found = Some(dir); break; }
        }
        let dir = found.ok_or_else(|| format!("找不到 DSH 会话 {id}"))?;
        let file = newest_session_file(&dir).ok_or("该 DSH 会话没有可读的 JSONL")?;
        let text = read_session_file(&file)?;
        let (header, events, title) = parse_session(&text)?;
        let cwd = header.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string());
        let title = title.or_else(|| header.get("title").and_then(|v| v.as_str()).map(|s| s.to_string()));
        Ok(Session { id: id.to_string(), runtime: "dsh".into(), cwd, title, updated_at: None, events })
    }

    fn write(&self, session: &Session, cwd: &str) -> Result<WriteResult, String> {
        let root = home().ok_or("无法解析 DSH 主目录")?.join("sessions");
        let id = format!("session-{}", uuid::Uuid::new_v4());
        let dir = root.join(cwd_slug(cwd)).join(&id);
        let id_for_header = id.clone();
        fs::create_dir_all(&dir).map_err(|e| format!("创建 DSH 会话目录失败: {e}"))?;
        let now = now_ms();
        let mut lines = Vec::new();
        lines.push(json!({
            "type": "session",
            "version": 0,
            "id": id_for_header,
            "createdAt": now,
            "delegationDepth": 0,
            "cwd": cwd,
        }));
        let mut seq = 0i64;
        let mut turn = 0i64;
        let mut step = 0i64;
        let mut turn_open = false;
        let mut step_open = false;
        let mut dropped = Vec::new();
        let mut push = |lines: &mut Vec<Value>, seq: &mut i64, value: Value| {
            let mut v = value;
            v["seq"] = json!(*seq);
            *seq += 1;
            lines.push(v);
        };
        for event in &session.events {
            match event.kind {
                EventKind::UserPrompt => {
                    if step_open {
                        push(&mut lines, &mut seq, json!({"type":"step/end","time":now,"data":{"turn":turn,"step":step}}));
                        step_open = false;
                    }
                    if turn_open {
                        push(&mut lines, &mut seq, json!({"type":"turn/end","time":now,"data":{"turn":turn,"reason":{"kind":"stop"}}}));
                        turn_open = false;
                    }
                    turn += 1;
                    step = 1;
                    push(&mut lines, &mut seq, json!({"type":"turn/start","time":now,"data":{"turn":turn}}));
                    push(&mut lines, &mut seq, json!({"type":"step/start","time":now,"data":{"turn":turn,"step":step}}));
                    push(&mut lines, &mut seq, json!({
                        "type":"user/message","time":now,"surfaceOp":"append",
                        "data":{"role":"user","id":format!("msg-{}", uuid::Uuid::new_v4()),"content":[{"type":"text","text":event.text.clone().unwrap_or_default()}],"source":{"kind":"user"}}
                    }));
                    turn_open = true;
                    step_open = true;
                }
                EventKind::AssistantReply => {
                    if !turn_open {
                        turn += 1;
                        step = 1;
                        push(&mut lines, &mut seq, json!({"type":"turn/start","time":now,"data":{"turn":turn}}));
                        turn_open = true;
                    } else if !step_open {
                        step += 1;
                        push(&mut lines, &mut seq, json!({"type":"step/start","time":now,"data":{"turn":turn,"step":step}}));
                    }
                    push(&mut lines, &mut seq, json!({
                        "type":"assistant/message","time":now,"surfaceOp":"append",
                        "data":{"turn":turn,"step":step,"message":{"id":format!("msg-{}", uuid::Uuid::new_v4()),"role":"assistant","content":[{"type":"text","text":event.text.clone().unwrap_or_default()}],"source":{"kind":"model","provider":"nimbusdesk","model":"imported"}}}
                    }));
                    push(&mut lines, &mut seq, json!({"type":"step/end","time":now,"data":{"turn":turn,"step":step}}));
                    step_open = false;
                }
                EventKind::ToolUse | EventKind::ToolResult => dropped.push("工具调用（v0 写入暂不保留）".into()),
                _ => {}
            }
        }
        if step_open {
            push(&mut lines, &mut seq, json!({"type":"step/end","time":now,"data":{"turn":turn,"step":step}}));
        }
        if turn_open {
            push(&mut lines, &mut seq, json!({"type":"turn/end","time":now,"data":{"turn":turn,"reason":{"kind":"stop"}}}));
        }
        let mut header_line = serde_json::to_vec(&lines[0]).map_err(|e| e.to_string())?;
        header_line.push(b'\n');
        let header_frame = zstd::encode_all(std::io::Cursor::new(header_line), 3)
            .map_err(|e| format!("zstd 压缩失败: {e}"))?;
        let mut body = String::new();
        for line in &lines[1..] {
            body.push_str(&serde_json::to_string(line).map_err(|e| e.to_string())?);
            body.push('\n');
        }
        let body_frame = zstd::encode_all(std::io::Cursor::new(body.into_bytes()), 3).map_err(|e| format!("zstd 压缩失败: {e}"))?;
        let file = dir.join("session.jsonl.zstd");
        let tmp = dir.join(".session.jsonl.zstd.tmp");
        {
            let mut f = fs::File::create(&tmp).map_err(|e| format!("创建 {} 失败: {e}", tmp.display()))?;
            f.write_all(&header_frame).map_err(|e| e.to_string())?;
            f.write_all(&body_frame).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
        }
        fs::rename(&tmp, &file).map_err(|e| format!("发布 DSH 会话失败: {e}"))?;
        register_workspace(&id, cwd)?;
        Ok(WriteResult { id: id.clone(), resume_command: Some(format!("dsh web --resume {id}")), path: Some(file.to_string_lossy().into_owned()), dropped })
    }
}

/// 把新会话挂进 workspace.json；同路径的工作区直接追加，否则新建「云台导入」。
fn register_workspace(session_id: &str, cwd: &str) -> Result<(), String> {
    let path = home().ok_or("无法解析 DSH 主目录")?.join("storages").join("workspace.json");
    if !path.exists() { return Ok(()); }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取 workspace.json 失败: {e}"))?;
    let backup = path.with_file_name(format!("workspace.json.bak-{}", chrono::Utc::now().format("%Y%m%d-%H%M%S")));
    fs::write(&backup, &text).map_err(|e| format!("备份 workspace.json 失败: {e}"))?;
    let mut root: Value = serde_json::from_str(&text).map_err(|e| format!("workspace.json 解析失败: {e}"))?;
    let target = root
        .pointer("/tables/workspaces")
        .and_then(|v| v.as_object())
        .and_then(|workspaces| {
            workspaces.iter().find_map(|(id, value)| {
                value.get("path").and_then(|v| v.as_str())
                    .filter(|p| p.eq_ignore_ascii_case(cwd))
                    .map(|_| id.clone())
            })
        });
    let ws_id = match target {
        Some(id) => id,
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            let title = Path::new(cwd).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "云台导入".into());
            if let Some(map) = root.pointer_mut("/tables/workspaces").and_then(|v| v.as_object_mut()) {
                map.insert(id.clone(), json!({
                    "path": cwd,
                    "title": title,
                    "sessionIds": [],
                    "createdAt": chrono::Utc::now().to_rfc3339(),
                    "updatedAt": chrono::Utc::now().to_rfc3339(),
                }));
            }
            if let Some(global) = root.pointer_mut("/global/workspaceIds").and_then(|v| v.as_array_mut()) {
                global.push(json!(id));
            }
            id
        }
    };
    if let Some(ws) = root.pointer_mut(&format!("/tables/workspaces/{ws_id}")).and_then(|v| v.as_object_mut()) {
        if let Some(ids) = ws.get_mut("sessionIds").and_then(|v| v.as_array_mut()) {
            if !ids.iter().any(|v| v.as_str() == Some(session_id)) { ids.push(json!(session_id)); }
        }
        ws["updatedAt"] = json!(chrono::Utc::now().to_rfc3339());
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(&root).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| format!("写回 workspace.json 失败: {e}"))?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::ir::EventKind;
    use crate::sessions::TEST_ENV_LOCK;

    #[test]
    fn slug_matches_known_directories() {
        assert_eq!(cwd_slug("C:\\Users\\dz"), "--C-Users-dz--");
        assert_eq!(cwd_slug("E:\\01-Desktop\\仙台\\deepseek"), "--E-01-Desktop-~4ED9~53F0-deepseek--");
    }

    #[test]
    fn write_uses_one_based_turns_and_reset_steps() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!("nimbus-dsh-seq-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        unsafe { std::env::set_var("DSH_HOME", &tmp); }
        let session = Session {
            id: "src".into(),
            runtime: "dsh".into(),
            cwd: Some(tmp.to_string_lossy().into_owned()),
            title: Some("seq".into()),
            updated_at: None,
            events: vec![
                Event { kind: EventKind::UserPrompt, text: Some("q1".into()), timestamp: None, tool: None, paths: vec![] },
                Event { kind: EventKind::AssistantReply, text: Some("a1".into()), timestamp: None, tool: None, paths: vec![] },
                Event { kind: EventKind::UserPrompt, text: Some("q2".into()), timestamp: None, tool: None, paths: vec![] },
                Event { kind: EventKind::AssistantReply, text: Some("a2".into()), timestamp: None, tool: None, paths: vec![] },
            ],
        };
        let result = Dsh.write(&session, &session.cwd.clone().unwrap()).unwrap();
        let bytes = std::fs::read(result.path.unwrap()).unwrap();
        let text = String::from_utf8(decode_zstd_frames(&bytes).unwrap()).unwrap();
        let rows: Vec<Value> = text.lines().filter(|line| !line.trim().is_empty()).map(|line| serde_json::from_str(line).unwrap()).collect();
        let starts: Vec<&Value> = rows.iter().filter(|row| row["type"] == "turn/start").collect();
        assert_eq!(starts.len(), 2);
        assert_eq!(starts[0]["data"]["turn"], 1);
        assert_eq!(starts[1]["data"]["turn"], 2);
        let steps: Vec<&Value> = rows.iter().filter(|row| row["type"] == "step/start").collect();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0]["data"]["step"], 1);
        assert_eq!(steps[1]["data"]["step"], 1);
        let user = rows.iter().find(|row| row["type"] == "user/message").unwrap();
        let assistant = rows.iter().find(|row| row["type"] == "assistant/message").unwrap();
        assert_eq!(user["surfaceOp"], "append");
        assert_eq!(assistant["surfaceOp"], "append");
        unsafe { std::env::remove_var("DSH_HOME"); }
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn roundtrip_writes_and_reads_v0() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!("nimbus-dsh-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        unsafe { std::env::set_var("DSH_HOME", &tmp); }
        let session = Session {
            id: "src".into(),
            runtime: "dsh".into(),
            cwd: Some(tmp.to_string_lossy().into_owned()),
            title: Some("hello".into()),
            updated_at: None,
            events: vec![
                Event { kind: EventKind::UserPrompt, text: Some("你好".into()), timestamp: None, tool: None, paths: vec![] },
                Event { kind: EventKind::AssistantReply, text: Some("世界".into()), timestamp: None, tool: None, paths: vec![] },
            ],
        };
        let result = Dsh.write(&session, &session.cwd.clone().unwrap()).unwrap();
        let read = Dsh.read(&result.id).unwrap_or_else(|error| panic!("read failed: {error}"));
        assert!(read.events.iter().any(|e| e.kind == EventKind::UserPrompt && e.text.as_deref() == Some("你好")));
        assert!(read.events.iter().any(|e| e.kind == EventKind::AssistantReply && e.text.as_deref() == Some("世界")));
        unsafe { std::env::remove_var("DSH_HOME"); }
        std::fs::remove_dir_all(&tmp).ok();
    }
}
