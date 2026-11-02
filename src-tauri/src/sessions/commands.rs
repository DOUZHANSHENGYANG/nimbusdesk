//! 会话管理的命令面：只做参数搬运 + spawn_blocking。
use crate::sessions::adapter;
use crate::sessions::ir::{Event, EventKind, RuntimeInfo, Session, SessionSummary};
use serde::Deserialize;
use crate::sessions::transfer::{self, MigrateReport, MigrateRequest};
use std::collections::BTreeMap;
use std::sync::Mutex;

type GraphState = BTreeMap<String, adapter::WriteResult>;
static GRAPH_LOCK: Mutex<()> = Mutex::new(());

fn graph_state_path() -> Option<std::path::PathBuf> {
    if let Some(path) = std::env::var_os("NIMBUS_SESSION_STATE").filter(|value| !value.is_empty()) {
        return Some(std::path::PathBuf::from(path).with_file_name("graph-state.json"));
    }
    dirs::home_dir().map(|home| home.join(".nimbusdesk").join("session-migration").join("graph-state.json"))
}

fn graph_key(graph: &serde_json::Value, target: &str, cwd: &str, title: &str) -> String {
    // Stable FNV-1a over the write context; DefaultHasher is not guaranteed
    // stable across Rust releases and would duplicate sessions after upgrades.
    let payload = format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}",
        serde_json::to_string(graph).unwrap_or_default(),
        target,
        cwd,
        title
    );
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in payload.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn load_graph_state() -> GraphState {
    let Some(path) = graph_state_path() else { return GraphState::new(); };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_graph_state(state: &GraphState) -> Result<(), String> {
    let Some(path) = graph_state_path() else { return Err("无法解析图迁移状态路径".into()); };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    crate::sessions::replace_state_file(&tmp, &path).map_err(|e| e.to_string())
}

async fn blocking<T: Send + 'static>(job: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| format!("会话后台任务失败: {e}"))?
}

#[tauri::command]
pub async fn sessions_runtimes() -> Result<Vec<RuntimeInfo>, String> {
    blocking(|| Ok(transfer::runtimes())).await
}

#[tauri::command]
pub async fn sessions_list(runtimes: Option<Vec<String>>) -> Result<Vec<SessionSummary>, String> {
    blocking(move || transfer::list(runtimes)).await
}

#[tauri::command]
pub async fn sessions_read(runtime: String, id: String) -> Result<Session, String> {
    blocking(move || transfer::read(&runtime, &id)).await
}

#[tauri::command]
pub async fn sessions_migrate(req: MigrateRequest) -> Result<MigrateReport, String> {
    blocking(move || transfer::migrate(req)).await
}

#[tauri::command]
pub async fn sessions_thought_graph(runtime: String, id: String) -> Result<serde_json::Value, String> {
    blocking(move || {
        let session = transfer::read(&runtime, &id)?;
        Ok(crate::sessions::canvas_graph::session_to_graph(&session))
    })
    .await
}

#[tauri::command]
pub async fn sessions_import_thought_graph(
    graph: serde_json::Value,
    cwd: Option<String>,
) -> Result<Session, String> {
    blocking(move || {
        Ok(crate::sessions::canvas_graph::graph_to_session(
            &graph,
            &uuid::Uuid::new_v4().to_string(),
            cwd.as_deref(),
        ))
    })
    .await
}

#[tauri::command]
pub async fn sessions_commit_thought_graph(
    graph: serde_json::Value,
    target: String,
    cwd: Option<String>,
    title: Option<String>,
) -> Result<crate::sessions::adapter::WriteResult, String> {
    blocking(move || {
        let _guard = GRAPH_LOCK.lock().map_err(|_| "图迁移锁已损坏".to_string())?;
        let cwd = cwd.unwrap_or_else(|| {
            dirs::home_dir()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
        if !std::path::Path::new(&cwd).is_dir() {
            return Err(format!("目标目录不存在: {cwd}"));
        }
        let adapter = crate::sessions::adapter::get(&target)?;
        if let Some(name) = transfer::target_app_running(adapter.id()) {
            return Err(format!("{name} 正在运行；请先退出目标客户端再写入，避免写入冲突"));
        }
        let mut session = crate::sessions::canvas_graph::graph_to_session(
            &graph,
            &uuid::Uuid::new_v4().to_string(),
            Some(&cwd),
        );
        let title_for_key = title.clone().unwrap_or_default();
        if let Some(title) = title.filter(|value| !value.trim().is_empty()) {
            session.title = Some(title);
        }
        if session.events.is_empty() {
            return Err("画布图里没有可迁移的问答节点".into());
        }
        let key = graph_key(&graph, adapter.id(), &cwd, &title_for_key);
        let mut state = load_graph_state();
        if let Some(existing) = state.get(&key) {
            return Ok(existing.clone());
        }
        let result = adapter.write(&session, &cwd)?;
        state.insert(key, result.clone());
        save_graph_state(&state)?;
        Ok(result)
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasMessage {
    pub role: String,
    pub text: String,
}

/// 把云台当前对话导出成一条 DSH 会话，供 ThoughtDAG 的「打开本机 Agent 对话」读取。
#[tauri::command]
pub async fn sessions_export_to_canvas(title: String, messages: Vec<CanvasMessage>) -> Result<String, String> {
    blocking(move || {
        if let Some(name) = transfer::target_app_running("dsh") {
            return Err(format!("{name} 正在运行；请先退出 DSH 再导出画布会话"));
        }
        let cwd = dirs::home_dir().ok_or("无法解析用户主目录")?;
        let cwd_text = cwd.to_string_lossy().into_owned();
        let mut events = Vec::new();
        for message in messages {
            let kind = match message.role.as_str() {
                "user" => EventKind::UserPrompt,
                "assistant" => EventKind::AssistantReply,
                _ => continue,
            };
            if message.text.trim().is_empty() {
                continue;
            }
            events.push(Event { kind, text: Some(message.text), timestamp: None, tool: None, paths: vec![] });
        }
        if events.is_empty() {
            return Err("当前对话没有可导出的消息".into());
        }
        let session = Session {
            id: uuid::Uuid::new_v4().to_string(),
            runtime: "dsh".into(),
            cwd: Some(cwd_text.clone()),
            title: Some(if title.trim().is_empty() { "云台对话".into() } else { title }),
            updated_at: None,
            events,
        };
        let target = adapter::get("dsh")?;
        Ok(target.write(&session, &cwd_text)?.id)
    })
    .await
}
