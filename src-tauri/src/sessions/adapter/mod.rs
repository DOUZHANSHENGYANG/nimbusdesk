//! Runtime adapter 层：reader（解析源格式）→ Session IR → writer（写目标格式）。
//!
//! 每个 runtime 只认识自己的原生存储；上层（transfer/commands/UI）只碰 IR。
//! 新增一家 = 一个 adapter + registry 一行 + fixtures，不需要改上层。
use crate::sessions::ir::{RuntimeInfo, Session, SessionSummary};
use std::path::PathBuf;

pub mod codex;
pub mod dsh;
pub mod opencode;
pub mod piagent;
pub mod pool;
pub mod workbuddy;

pub trait Adapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn label(&self) -> &'static str;
    /// 原生存储根目录；不存在即视为该 runtime 未安装/未使用。
    fn home(&self) -> Option<PathBuf>;
    fn discover(&self) -> Result<Vec<SessionSummary>, String>;
    fn read(&self, id: &str) -> Result<Session, String>;
    /// 把 IR 写成目标 runtime 的新会话；绝不修改源会话。
    fn write(&self, session: &Session, cwd: &str) -> Result<WriteResult, String>;
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub id: String,
    /// 目标 runtime 继续该会话的命令（可空）。
    #[serde(default)]
    pub resume_command: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    /// 写入过程中被明确丢弃/降级的内容。
    #[serde(default)]
    pub dropped: Vec<String>,
}

pub fn all() -> Vec<Box<dyn Adapter>> {
    vec![
        Box::new(opencode::OpenCode),
        Box::new(dsh::Dsh),
        Box::new(workbuddy::WorkBuddy),
        Box::new(codex::Codex),
        Box::new(piagent::PiAgent),
        Box::new(pool::Pool),
    ]
}

pub fn get(id: &str) -> Result<Box<dyn Adapter>, String> {
    let key = id.trim().to_ascii_lowercase();
    let key = match key.as_str() {
        "oc" | "open-code" => "opencode",
        "deepseek" | "deepseek-harness" | "harness" => "dsh",
        "wb" | "work-buddy" | "workbuddy-ai" => "workbuddy",
        "codex-cli" => "codex",
        "pi" | "piagent" | "pi-agent-cli" => "pi-agent",
        "central" | "hub" => "pool",
        other => other,
    };
    all()
        .into_iter()
        .find(|a| a.id() == key)
        .ok_or_else(|| format!("未知的会话来源: {id}（支持 opencode / dsh / workbuddy / codex / pi-agent / pool）"))
}

pub fn runtime_infos() -> Vec<RuntimeInfo> {
    all()
        .into_iter()
        .map(|a| {
            let home = a.home();
            RuntimeInfo {
                id: a.id().into(),
                label: a.label().into(),
                available: home.as_ref().map(|p| p.exists()).unwrap_or(false),
                home: home.map(|p| p.to_string_lossy().into_owned()),
                note: String::new(),
            }
        })
        .collect()
}

pub(crate) fn user_home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "无法解析用户主目录".to_string())
}

pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub(crate) fn read_to_string(path: &std::path::Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))
}
