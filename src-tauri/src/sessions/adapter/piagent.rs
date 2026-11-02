//! pi-agent 会话适配器。
//!
//! 原生格式（实测 `~/.pi/agent/sessions/<cwd-slug>/<ISO>_<uuid>.jsonl`）：
//! 第一行 `{"type":"session","version":3,"id","timestamp","cwd"}`，
//! 之后逐行事件，常见 type：`message`（`message.role` = user/assistant/tool，
//! `message.content[]` 里 `text` / `toolCall` / `toolResult`）、`compaction`、
//! `session_info`、`model_change`、`custom` 等。事件带 `id`/`parentId`（树形），
//! IR 不需要树，按行序铺平即可。
//!
//! 注意：它不是 DSH 格式（那是 zstd 多帧 + `session-<uuid>/` 目录），
//! 也不是 Codex 的 rollout，所以单独一个 adapter。
use super::{now_ms, user_home, Adapter, WriteResult};
use crate::sessions::ir::{Event, EventKind, Session, SessionSummary};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct PiAgent;

pub fn home() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("PI_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(root));
    }
    user_home().ok().map(|h| h.join(".pi"))
}

/// `~/.pi/agent/sessions`
fn sessions_root() -> Result<PathBuf, String> {
    Ok(home().ok_or("无法解析 pi-agent 主目录")?.join("agent").join("sessions"))
}

/// 目录名规则（实测 `E:\\01-Desktop\\pi` → `--E--01-Desktop-pi--`）：
/// 字母数字保留，`:` 展开成两个短横，其余非字母数字各折一个短横，连续短横压到最多两个。
pub fn cwd_slug(cwd: &str) -> String {
    let mut body = String::new();
    for ch in cwd.chars() {
        if ch.is_ascii_alphanumeric() {
            body.push(ch);
        } else if ch == ':' {
            body.push_str("--");
        } else {
            body.push('-');
        }
    }
    while body.contains("---") {
        body = body.replace("---", "--");
    }
    format!("--{}--", body.trim_matches('-'))
}

/// content[] 里按类型拆出文本、工具调用、工具结果。
fn split_content(value: Option<&Value>) -> (String, Vec<(String, String)>, Vec<String>) {
    let mut text = String::new();
    let mut calls = Vec::new();
    let mut results = Vec::new();
    let Some(items) = value.and_then(|v| v.as_array()) else {
        return (text, calls, results);
    };
    for item in items {
        let ty = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match ty {
            "text" | "input_text" | "output_text" => {
                if let Some(part) = item.get("text").and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(part);
                }
            }
            "toolCall" | "tool_use" | "tool_call" => {
                let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("tool").to_string();
                let args = item
                    .get("arguments")
                    .or_else(|| item.get("input"))
                    .map(|v| v.to_string())
                    .unwrap_or_default();
                calls.push((name, args));
            }
            "toolResult" | "tool_result" => {
                let body = item
                    .get("content")
                    .or_else(|| item.get("output"))
                    .map(|v| match v {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    })
                    .unwrap_or_default();
                results.push(body);
            }
            _ => {}
        }
    }
    (text, calls, results)
}

/// 解析一个会话文件：会话本体 + 第一条真实用户输入（做标题用）+ 行数。
fn parse_file(path: &Path) -> Result<(Session, Option<String>, usize), String> {
    let text = super::read_to_string(path)?;
    let mut session = Session {
        // 会话 id 取文件 stem 的后半段 uuid（read 时按 stem 反查，保持一致）
        id: path.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown").to_string(),
        runtime: "pi-agent".into(),
        ..Default::default()
    };
    let mut first_user: Option<String> = None;
    let mut count = 0usize;

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue };
        count += 1;
        let ty = row.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let ts = row.get("timestamp").and_then(|v| v.as_str()).map(|s| s.to_string());

        match ty {
            "session" => {
                session.cwd = row.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string());
            }
            "compaction" => {
                session.events.push(Event { kind: EventKind::CompactSummary, text: None, timestamp: ts, tool: None, paths: vec![] });
            }
            "message" => {
                let message = row.get("message");
                let role = message.and_then(|m| m.get("role")).and_then(|v| v.as_str()).unwrap_or("");
                let (text, calls, results) = split_content(message.and_then(|m| m.get("content")));
                match role {
                    "user" => {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            if first_user.is_none() {
                                first_user = Some(trimmed.to_string());
                            }
                            session.events.push(Event { kind: EventKind::UserPrompt, text: Some(trimmed.to_string()), timestamp: ts.clone(), tool: None, paths: vec![] });
                        }
                    }
                    "assistant" => {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            session.events.push(Event { kind: EventKind::AssistantReply, text: Some(trimmed.to_string()), timestamp: ts.clone(), tool: None, paths: vec![] });
                        }
                    }
                    _ => {}
                }
                for (name, args) in calls {
                    session.events.push(Event { kind: EventKind::ToolUse, text: Some(args), timestamp: ts.clone(), tool: Some(name), paths: vec![] });
                }
                for body in results {
                    session.events.push(Event { kind: EventKind::ToolResult, text: Some(body), timestamp: ts.clone(), tool: None, paths: vec![] });
                }
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

/// 扫描一个 sessions 根（抽出来是为了测试能指定根目录）。
fn discover_in(root: &Path) -> Vec<SessionSummary> {
    let mut out = Vec::new();
    let Ok(projects) = fs::read_dir(root) else { return out };
    for project in projects.flatten() {
        if !project.path().is_dir() {
            continue;
        }
        for file in fs::read_dir(project.path()).into_iter().flatten().flatten() {
            let path = file.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(current) = crate::sessions::index::stamp(&path) else { continue };
            if let Some(hit) = crate::sessions::index::lookup("pi-agent", &path, current) {
                out.push(hit);
                continue;
            }
            let size = current.size;
            let parsed = if size <= 32 * 1024 * 1024 { parse_file(&path).ok() } else { None };
            let (title, cwd, count) = parsed.map(|(s, _, c)| (s.title, s.cwd, c)).unwrap_or((None, None, 0));
            let summary = SessionSummary {
                id: path.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown").to_string(),
                runtime: "pi-agent".into(),
                title,
                cwd,
                updated_at: Some(current.mtime_ms),
                message_count: count,
                size_bytes: size,
            };
            crate::sessions::index::store("pi-agent", &path, current, summary.clone());
            out.push(summary);
        }
    }
    out.sort_by(|a, b| b.updated_at.unwrap_or(0).cmp(&a.updated_at.unwrap_or(0)));
    out
}

impl Adapter for PiAgent {
    fn id(&self) -> &'static str { "pi-agent" }
    fn label(&self) -> &'static str { "pi agent" }
    fn home(&self) -> Option<PathBuf> { home() }

    fn discover(&self) -> Result<Vec<SessionSummary>, String> {
        Ok(discover_in(&sessions_root()?))
    }

    fn read(&self, id: &str) -> Result<Session, String> {
        let root = sessions_root()?;
        for project in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
            let path = project.path().join(format!("{id}.jsonl"));
            if path.exists() {
                let (session, _, _) = parse_file(&path)?;
                return Ok(session);
            }
        }
        Err(format!("找不到 pi-agent 会话 {id}"))
    }

    fn write(&self, session: &Session, cwd: &str) -> Result<WriteResult, String> {
        let root = sessions_root()?.join(cwd_slug(cwd));
        fs::create_dir_all(&root).map_err(|e| format!("创建 pi-agent 会话目录失败: {e}"))?;

        let session_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now();
        let stamp = now.format("%Y-%m-%dT%H-%M-%S-%3fZ").to_string();
        let file = root.join(format!("{stamp}_{session_id}.jsonl"));
        let tmp = root.join(format!(".{session_id}.jsonl.tmp"));
        let mut dropped = Vec::new();

        {
            let mut f = fs::File::create(&tmp).map_err(|e| format!("创建 {} 失败: {e}", tmp.display()))?;
            let head = json!({
                "type": "session",
                "version": 3,
                "id": session_id,
                "timestamp": now.to_rfc3339(),
                "cwd": cwd,
            });
            f.write_all(serde_json::to_string(&head).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
            f.write_all(b"\n").map_err(|e| e.to_string())?;

            let mut parent: Option<String> = None;
            for event in &session.events {
                let role = match event.kind {
                    EventKind::UserPrompt => "user",
                    EventKind::AssistantReply => "assistant",
                    EventKind::CompactSummary => {
                        let row = json!({
                            "type": "compaction",
                            "id": uuid::Uuid::new_v4().to_string(),
                            "parentId": parent,
                            "timestamp": event.timestamp.clone().unwrap_or_else(|| now.to_rfc3339()),
                        });
                        f.write_all(serde_json::to_string(&row).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
                        f.write_all(b"\n").map_err(|e| e.to_string())?;
                        continue;
                    }
                    EventKind::ToolUse | EventKind::ToolResult => {
                        dropped.push("工具调用（pi-agent 写入暂不保留）".into());
                        continue;
                    }
                    _ => continue,
                };
                let id = uuid::Uuid::new_v4().to_string();
                let row = json!({
                    "type": "message",
                    "id": id,
                    "parentId": parent,
                    "timestamp": event.timestamp.clone().unwrap_or_else(|| now.to_rfc3339()),
                    "message": {
                        "role": role,
                        "content": [{"type": "text", "text": event.text.clone().unwrap_or_default()}],
                    },
                });
                f.write_all(serde_json::to_string(&row).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
                f.write_all(b"\n").map_err(|e| e.to_string())?;
                parent = Some(id);
            }
            f.sync_all().map_err(|e| e.to_string())?;
        }
        fs::rename(&tmp, &file).map_err(|e| format!("写入 pi-agent 会话失败: {e}"))?;

        Ok(WriteResult {
            id: file.file_stem().and_then(|s| s.to_str()).unwrap_or(&session_id).to_string(),
            resume_command: Some(format!("pi --resume {session_id}")),
            path: Some(file.to_string_lossy().into_owned()),
            dropped,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = concat!(
        r##"{"type":"session","version":3,"id":"019ee884-ff78-7dfc-b8dd-fc3ef7c2d9d2","timestamp":"2026-06-21T04:51:30.808Z","cwd":"E:\\01-Desktop\\pi"}"##,
        "\n",
        r##"{"type":"model_change","id":"4a59c56f","parentId":null,"timestamp":"2026-06-21T04:51:36.305Z","provider":"antigravity","modelId":"deepseek-v4-pro"}"##,
        "\n",
        r##"{"type":"message","id":"5f5328c0","parentId":"8cdc5c48","timestamp":"2026-06-21T05:08:01.681Z","message":{"role":"user","content":[{"type":"text","text":"这些扩展和 skills 作用是啥"}]}}"##,
        "\n",
        r##"{"type":"message","id":"4c9280b1","parentId":"040594af","timestamp":"2026-06-21T05:08:46.367Z","message":{"role":"assistant","content":[{"type":"text","text":"让我看看配置"},{"type":"toolCall","id":"call_00","name":"ctx_read","arguments":{"path":"E:/01-Desktop/pi"}}]}}"##,
        "\n",
        r##"{"type":"compaction","id":"c1","parentId":"4c9280b1","timestamp":"2026-06-21T05:09:00.000Z"}"##,
        "\n",
    );

    fn write_sample(dir: &Path) -> PathBuf {
        let path = dir.join("agent").join("sessions").join("--E--01-Desktop-pi--");
        fs::create_dir_all(&path).unwrap();
        let file = path.join("2026-06-21T04-51-30-808Z_019ee884-ff78-7dfc-b8dd-fc3ef7c2d9d2.jsonl");
        fs::write(&file, SAMPLE).unwrap();
        file
    }

    #[test]
    fn slug_matches_observed_layout() {
        assert_eq!(cwd_slug("E:\\01-Desktop\\pi"), "--E--01-Desktop-pi--");
    }

    #[test]
    fn parses_pi_session_shape() {
        let dir = std::env::temp_dir().join(format!("pi-adapter-{}", uuid::Uuid::new_v4()));
        let file = write_sample(&dir);
        let (session, first_user, count) = parse_file(&file).unwrap();

        assert_eq!(session.runtime, "pi-agent");
        assert_eq!(session.cwd.as_deref(), Some("E:\\01-Desktop\\pi"));
        assert_eq!(count, 5);
        assert_eq!(first_user.as_deref(), Some("这些扩展和 skills 作用是啥"));
        assert_eq!(session.title.as_deref(), Some("这些扩展和 skills 作用是啥"));
        assert!(session.events.iter().any(|e| e.kind == EventKind::ToolUse && e.tool.as_deref() == Some("ctx_read")));
        assert!(session.events.iter().any(|e| e.kind == EventKind::AssistantReply));
        assert!(session.events.iter().any(|e| e.kind == EventKind::CompactSummary));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn discovers_sessions_under_slug_dirs() {
        let dir = std::env::temp_dir().join(format!("pi-scan-{}", uuid::Uuid::new_v4()));
        write_sample(&dir);
        let found = discover_in(&dir.join("agent").join("sessions"));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].runtime, "pi-agent");
        assert!(found[0].title.is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn second_scan_reuses_cached_summaries() {
        let dir = std::env::temp_dir().join(format!("pi-cache-{}", uuid::Uuid::new_v4()));
        write_sample(&dir);
        let root = dir.join("agent").join("sessions");

        let before = crate::sessions::index::hits();
        let first = discover_in(&root);
        assert_eq!(first.len(), 1);
        let after_first = crate::sessions::index::hits();
        assert_eq!(after_first, before, "第一次扫描应该是解析，不是命中缓存");

        let second = discover_in(&root);
        assert_eq!(second.len(), 1);
        assert!(crate::sessions::index::hits() > after_first, "第二次扫描应当命中缓存");
        assert_eq!(second[0].title, first[0].title);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "读本机真实 ~/.pi/agent/sessions；用 --ignored 手动跑"]
    fn reads_real_pi_sessions_from_disk() {
        let root = sessions_root().unwrap();
        let found = discover_in(&root);
        assert!(!found.is_empty(), "本机应能扫到 pi-agent 会话：{}", root.display());
        assert!(found.iter().any(|s| s.title.is_some()), "至少有一条能取到标题");
    }
}
