//! Codex CLI 会话适配器。
//!
//! 原生格式（实测 `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`）：
//! 逐行 JSON，第一行是 `session_meta`（带 id / cwd / cli_version / model_provider），
//! 之后是 `response_item`（payload.type=message，role=user|assistant，content[]）、
//! `turn_context`、`event_msg`。工具调用是 payload.type=function_call /
//! function_call_output —— 都按 response_item 处理。
//!
//! 目录按日期分三层，所以 discover 要递归走；文件名很长，会话 id 直接用文件 stem
//! （read 时靠它反查），真正的 uuid 在 session_meta 里，不进 IR。
use super::{now_ms, user_home, Adapter, WriteResult};
use crate::sessions::ir::{Event, EventKind, Session, SessionSummary};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct Codex;

pub fn home() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(root));
    }
    user_home().ok().map(|h| h.join(".codex"))
}

/// `~/.codex/sessions`；不存在时仍返回路径，由调用方判断空。
fn sessions_root() -> Result<PathBuf, String> {
    Ok(home().ok_or("无法解析 Codex 主目录")?.join("sessions"))
}

/// 递归收集 rollout 文件（sessions/<年>/<月>/<日>/*.jsonl）。
fn collect_rollouts(root: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 4 || out.len() >= 2000 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rollouts(&path, depth + 1, out);
        } else if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

/// content[] 里把所有文本拼起来（Codex 的 message 内容是个数组）。
fn content_text(value: Option<&Value>) -> String {
    let Some(value) = value else { return String::new() };
    let mut parts = Vec::new();
    if let Some(items) = value.as_array() {
        for item in items {
            if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                if !text.trim().is_empty() {
                    parts.push(text.to_string());
                }
            }
        }
    } else if let Some(text) = value.as_str() {
        parts.push(text.to_string());
    }
    parts.join("\n")
}

/// Codex 会把 AGENTS.md、环境说明之类包在 user 消息里，列表标题要跳过这些。
fn user_prompt_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lowered = trimmed.to_ascii_lowercase();
    let boilerplate = [
        "# agents.md instructions",
        "<instructions>",
        "<environment_context>",
        "<user_instructions>",
    ];
    if boilerplate.iter().any(|mark| lowered.starts_with(mark)) {
        return None;
    }
    Some(trimmed.to_string())
}

/// 解析一个 rollout 文件：会话本体 + 第一条真实用户输入（做标题用）+ 行数。
fn parse_file(path: &Path) -> Result<(Session, Option<String>, usize), String> {
    let text = super::read_to_string(path)?;
    let mut session = Session {
        id: path.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown").to_string(),
        runtime: "codex".into(),
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
        let payload = row.get("payload");

        match ty {
            "session_meta" => {
                if session.cwd.is_none() {
                    session.cwd = payload
                        .and_then(|p| p.get("cwd"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                }
            }
            "response_item" => {
                let kind = payload.and_then(|p| p.get("type")).and_then(|v| v.as_str()).unwrap_or("");
                match kind {
                    "message" => {
                        let role = payload.and_then(|p| p.get("role")).and_then(|v| v.as_str()).unwrap_or("");
                        let text = content_text(payload.and_then(|p| p.get("content")));
                        if role == "user" {
                            let Some(prompt) = user_prompt_text(&text) else { continue };
                            if first_user.is_none() {
                                first_user = Some(prompt.clone());
                            }
                            session.events.push(Event { kind: EventKind::UserPrompt, text: Some(prompt), timestamp: ts, tool: None, paths: vec![] });
                        } else if role == "assistant" {
                            if text.trim().is_empty() {
                                continue;
                            }
                            session.events.push(Event { kind: EventKind::AssistantReply, text: Some(text), timestamp: ts, tool: None, paths: vec![] });
                        }
                    }
                    "function_call" => {
                        let name = payload.and_then(|p| p.get("name")).and_then(|v| v.as_str()).unwrap_or("tool");
                        let args = payload.and_then(|p| p.get("arguments")).map(|v| v.to_string()).unwrap_or_default();
                        session.events.push(Event { kind: EventKind::ToolUse, text: Some(args), timestamp: ts, tool: Some(name.to_string()), paths: vec![] });
                    }
                    "function_call_output" => {
                        let output = payload.and_then(|p| p.get("output")).map(|v| match v {
                            Value::String(s) => s.clone(),
                            other => other.to_string(),
                        }).unwrap_or_default();
                        session.events.push(Event { kind: EventKind::ToolResult, text: Some(output), timestamp: ts, tool: None, paths: vec![] });
                    }
                    "reasoning" => {
                        session.events.push(Event { kind: EventKind::Other, text: None, timestamp: ts, tool: None, paths: vec![] });
                    }
                    _ => {}
                }
            }
            "turn_context" => {
                session.events.push(Event { kind: EventKind::TurnEnd, text: None, timestamp: ts, tool: None, paths: vec![] });
            }
            "compacted" => {
                session.events.push(Event { kind: EventKind::CompactSummary, text: None, timestamp: ts, tool: None, paths: vec![] });
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

/// 扫描一个 sessions 根下的所有 rollout（抽出来是为了测试能指定根目录）。
fn discover_in(root: &Path) -> Vec<SessionSummary> {
    let mut out = Vec::new();
    if !root.exists() {
        return out;
    }
    let mut files = Vec::new();
    collect_rollouts(root, 0, &mut files);

    for path in files {
        // 戳记（size + mtime）没变就直接用缓存摘要，不再把几十 MB 的 rollout 重读一遍
        let Some(current) = crate::sessions::index::stamp(&path) else { continue };
        if let Some(hit) = crate::sessions::index::lookup("codex", &path, current) {
            out.push(hit);
            continue;
        }
        let size = current.size;
        let parsed = if size <= 32 * 1024 * 1024 { parse_file(&path).ok() } else { None };
        let (title, cwd, count) = parsed.map(|(s, _, c)| (s.title, s.cwd, c)).unwrap_or((None, None, 0));
        let summary = SessionSummary {
            id: path.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown").to_string(),
            runtime: "codex".into(),
            title,
            cwd,
            updated_at: Some(current.mtime_ms),
            message_count: count,
            size_bytes: size,
        };
        crate::sessions::index::store("codex", &path, current, summary.clone());
        out.push(summary);
    }
    out.sort_by(|a, b| b.updated_at.unwrap_or(0).cmp(&a.updated_at.unwrap_or(0)));
    out
}

impl Adapter for Codex {
    fn id(&self) -> &'static str { "codex" }
    fn label(&self) -> &'static str { "Codex CLI" }
    fn home(&self) -> Option<PathBuf> { home() }

    fn discover(&self) -> Result<Vec<SessionSummary>, String> {
        Ok(discover_in(&sessions_root()?))
    }

    fn read(&self, id: &str) -> Result<Session, String> {
        let root = sessions_root()?;
        let mut files = Vec::new();
        collect_rollouts(&root, 0, &mut files);
        for path in files {
            if path.file_stem().and_then(|s| s.to_str()) == Some(id) {
                let (session, _, _) = parse_file(&path)?;
                return Ok(session);
            }
        }
        Err(format!("找不到 Codex 会话 {id}"))
    }

    fn write(&self, session: &Session, cwd: &str) -> Result<WriteResult, String> {
        let now = chrono::Utc::now();
        let root = sessions_root()?
            .join(now.format("%Y").to_string())
            .join(now.format("%m").to_string())
            .join(now.format("%d").to_string());
        fs::create_dir_all(&root).map_err(|e| format!("创建 Codex 会话目录失败: {e}"))?;

        let session_id = uuid::Uuid::new_v4().to_string();
        let stamp = now.format("%Y-%m-%dT%H-%M-%S").to_string();
        let file = root.join(format!("rollout-{stamp}-{session_id}.jsonl"));
        let tmp = root.join(format!(".{session_id}.jsonl.tmp"));
        let mut dropped = Vec::new();

        {
            let mut f = fs::File::create(&tmp).map_err(|e| format!("创建 {} 失败: {e}", tmp.display()))?;
            let meta = json!({
                "timestamp": now.to_rfc3339(),
                "type": "session_meta",
                "payload": {
                    "id": session_id,
                    "timestamp": now.to_rfc3339(),
                    "cwd": cwd,
                    "originator": "nimbusdesk",
                    "cli_version": "0.0.0",
                    "source": "transfer",
                },
            });
            f.write_all(serde_json::to_string(&meta).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
            f.write_all(b"\n").map_err(|e| e.to_string())?;

            for event in &session.events {
                let role = match event.kind {
                    EventKind::UserPrompt => "user",
                    EventKind::AssistantReply => "assistant",
                    EventKind::ToolUse | EventKind::ToolResult => {
                        dropped.push("工具调用（Codex rollout 写入暂不保留）".into());
                        continue;
                    }
                    EventKind::TurnEnd => {
                        let row = json!({
                            "timestamp": event.timestamp.clone().unwrap_or_else(|| now.to_rfc3339()),
                            "type": "turn_context",
                            "payload": {"cwd": cwd},
                        });
                        f.write_all(serde_json::to_string(&row).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
                        f.write_all(b"\n").map_err(|e| e.to_string())?;
                        continue;
                    }
                    _ => continue,
                };
                let content_type = if role == "user" { "input_text" } else { "output_text" };
                let row = json!({
                    "timestamp": event.timestamp.clone().unwrap_or_else(|| now.to_rfc3339()),
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": role,
                        "content": [{"type": content_type, "text": event.text.clone().unwrap_or_default()}],
                    },
                });
                f.write_all(serde_json::to_string(&row).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
                f.write_all(b"\n").map_err(|e| e.to_string())?;
            }
            f.sync_all().map_err(|e| e.to_string())?;
        }
        fs::rename(&tmp, &file).map_err(|e| format!("写入 Codex 会话失败: {e}"))?;

        Ok(WriteResult {
            id: file.file_stem().and_then(|s| s.to_str()).unwrap_or(&session_id).to_string(),
            resume_command: Some(format!("codex resume {session_id}")),
            path: Some(file.to_string_lossy().into_owned()),
            dropped,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = concat!(
        r##"{"timestamp":"2026-06-20T09:24:00.033Z","type":"session_meta","payload":{"id":"019ee458-19e2-7782-a647-2acb777bbb6e","timestamp":"2026-06-20T09:23:59.616Z","cwd":"D:\\08-Project\\OpenDesign","cli_version":"0.114.0"}}"##,
        "\n",
        r##"{"timestamp":"2026-06-20T09:24:00.036Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for D:\\x\n<INSTRUCTIONS>env</INSTRUCTIONS>"}]}}"##,
        "\n",
        r##"{"timestamp":"2026-06-20T09:24:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"帮我把这个函数拆开"}]}}"##,
        "\n",
        r##"{"timestamp":"2026-06-20T09:24:02.000Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"cmd\":\"ls\"}"}}"##,
        "\n",
        r##"{"timestamp":"2026-06-20T09:24:03.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"好的，我把 shell 部分抽出来。"}]}}"##,
        "\n",
        r##"{"timestamp":"2026-06-20T09:24:04.000Z","type":"turn_context","payload":{"cwd":"D:\\08-Project\\OpenDesign"}}"##,
        "\n",
    );

    fn write_sample(dir: &Path) -> PathBuf {
        let path = dir.join("sessions").join("2026").join("06").join("20");
        fs::create_dir_all(&path).unwrap();
        let file = path.join("rollout-2026-06-20T17-23-59-019ee458.jsonl");
        fs::write(&file, SAMPLE).unwrap();
        file
    }

    #[test]
    fn parses_session_meta_prompt_reply_and_tool() {
        let dir = std::env::temp_dir().join(format!("codex-adapter-{}", uuid::Uuid::new_v4()));
        let file = write_sample(&dir);
        let (session, first_user, count) = parse_file(&file).unwrap();

        assert_eq!(session.runtime, "codex");
        assert_eq!(session.cwd.as_deref(), Some("D:\\08-Project\\OpenDesign"));
        assert_eq!(count, 6);
        // AGENTS.md 那段样板不该当标题，真正的第一条用户输入才是
        assert_eq!(first_user.as_deref(), Some("帮我把这个函数拆开"));
        assert_eq!(session.title.as_deref(), Some("帮我把这个函数拆开"));
        assert!(session.events.iter().any(|e| e.kind == EventKind::ToolUse && e.tool.as_deref() == Some("shell")));
        assert!(session.events.iter().any(|e| e.kind == EventKind::AssistantReply));
        assert!(session.events.iter().any(|e| e.kind == EventKind::TurnEnd));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn second_scan_reuses_cached_summaries() {
        let dir = std::env::temp_dir().join(format!("codex-cache-{}", uuid::Uuid::new_v4()));
        write_sample(&dir);
        let root = dir.join("sessions");

        let before = crate::sessions::index::hits();
        let first = discover_in(&root);
        assert_eq!(first.len(), 1);
        let after_first = crate::sessions::index::hits();
        assert_eq!(after_first, before, "第一次扫描应该是解析，不是命中缓存");

        let second = discover_in(&root);
        assert_eq!(second.len(), 1);
        assert!(crate::sessions::index::hits() > after_first, "第二次扫描应当命中缓存");
        assert_eq!(second[0].title, first[0].title, "缓存摘要应与解析结果一致");
        assert_eq!(second[0].updated_at, first[0].updated_at);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "读本机真实 ~/.codex/sessions；用 --ignored 手动跑"]
    fn reads_real_codex_sessions_from_disk() {
        let root = sessions_root().unwrap();
        let cold = std::time::Instant::now();
        let found = discover_in(&root);
        let cold_ms = cold.elapsed().as_millis();

        assert!(!found.is_empty(), "本机应能扫到 Codex rollout：{}", root.display());
        let with_title = found.iter().filter(|s| s.title.is_some()).count();
        assert!(with_title > 0, "至少有一条能取到标题：{found:?}");
        assert!(found[0].updated_at.is_some());

        // 第二次：文件没动，应该全部走缓存
        let warm = std::time::Instant::now();
        let again = discover_in(&root);
        let warm_ms = warm.elapsed().as_millis();
        assert_eq!(again.len(), found.len());
        println!("[codex] {} 条会话：冷扫 {cold_ms}ms → 热扫（缓存）{warm_ms}ms", found.len());
    }

    #[test]
    fn discovers_rollouts_under_date_dirs() {
        let dir = std::env::temp_dir().join(format!("codex-scan-{}", uuid::Uuid::new_v4()));
        write_sample(&dir);
        let found = discover_in(&dir.join("sessions"));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].runtime, "codex");
        assert!(found[0].title.is_some());
        assert_eq!(found[0].cwd.as_deref(), Some("D:\\08-Project\\OpenDesign"));
        let _ = fs::remove_dir_all(&dir);
    }
}
