//! 跨 harness 会话的统一中间表示（IR）。
//!
//! 参照 Einsia/agent-git 的 Session/Event 设计（MIT）：IR 故意很小，
//! 只保留三家 runtime 都能表达、上层真正用得到的东西；工具参数/思考正文
//! 这类不可移植的内容不进 IR，需要时由各 adapter 的 raw 坐标回读。
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    UserPrompt,
    /// 回合进行中用户插话（不开启新回合）。
    UserInterjection,
    AssistantReply,
    ToolUse,
    ToolResult,
    FileEdit,
    /// 上下文压缩：过滤型（Codex）或摘要型（Claude/DSH）。
    CompactFiltered,
    CompactSummary,
    TurnEnd,
    Other,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub kind: EventKind,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub paths: Vec<String>,
}

impl Default for EventKind {
    fn default() -> Self {
        EventKind::Other
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub runtime: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub updated_at: Option<i64>,
    #[serde(default)]
    pub events: Vec<Event>,
}

impl Session {
    pub fn gist(&self, max_chars: usize) -> Option<String> {
        let text = self
            .events
            .iter()
            .find(|e| e.kind == EventKind::UserPrompt)
            .and_then(|e| e.text.as_deref())?;
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }
        let mut out: String = trimmed.chars().take(max_chars).collect();
        if trimmed.chars().count() > max_chars {
            out.push('…');
        }
        Some(out.replace('\n', " "))
    }

    pub fn counts(&self) -> SessionCounts {
        let mut c = SessionCounts::default();
        for e in &self.events {
            match e.kind {
                EventKind::UserPrompt => c.prompts += 1,
                EventKind::UserInterjection => c.interjections += 1,
                EventKind::AssistantReply => c.replies += 1,
                EventKind::ToolUse => c.tools += 1,
                EventKind::ToolResult => c.outputs += 1,
                EventKind::FileEdit => c.edits += 1,
                EventKind::CompactFiltered | EventKind::CompactSummary => c.compactions += 1,
                EventKind::TurnEnd | EventKind::Other => {}
            }
        }
        c
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCounts {
    pub prompts: usize,
    pub interjections: usize,
    pub replies: usize,
    pub tools: usize,
    pub outputs: usize,
    pub edits: usize,
    pub compactions: usize,
}

/// 列表用的轻量摘要 —— 扫描一百条会话时不该把正文全读进内存。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub runtime: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub updated_at: Option<i64>,
    #[serde(default)]
    pub message_count: usize,
    #[serde(default)]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub id: String,
    pub label: String,
    pub available: bool,
    #[serde(default)]
    pub home: Option<String>,
    #[serde(default)]
    pub note: String,
}
