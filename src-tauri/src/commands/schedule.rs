//! 定时任务的命令面。
//!
//! 命令只做两件事：把参数交给 `schedule::engine`、把结果要回来。
//! 「下次运行时刻」一律由 Rust 算（`schedule_preview`），前端不再算第二套。

use crate::schedule::actions::Outcome;
use crate::schedule::model::{self, Frequency, HistoryEntry, Task};
use crate::schedule::engine;
use chrono::Local;
use serde_json::Value;

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|error| format!("定时任务后台任务失败: {error}"))?
}

/// 任务表 + 运行历史 + 动作注册表，一次取齐（界面只发一条查询）。
#[tauri::command]
pub async fn schedule_snapshot() -> Result<Value, String> {
    blocking(engine::snapshot).await
}

/// 新建（id 为空）或更新一个任务。
#[tauri::command]
pub async fn schedule_save(task: Task) -> Result<Task, String> {
    blocking(move || engine::upsert_task(task)).await
}

#[tauri::command]
pub async fn schedule_delete(id: String) -> Result<(), String> {
    blocking(move || engine::delete_task(&id)).await
}

#[tauri::command]
pub async fn schedule_set_enabled(id: String, enabled: bool) -> Result<Option<Task>, String> {
    blocking(move || engine::set_enabled(&id, enabled)).await
}

#[tauri::command]
pub async fn schedule_clear_history() -> Result<(), String> {
    blocking(engine::clear_history).await
}

/// 立即运行一次（不看启用状态）。
#[tauri::command]
pub async fn schedule_run_now(id: String) -> Result<HistoryEntry, String> {
    blocking(move || engine::get()?.run_now(&id)).await
}

/// 频率 → 接下来几次运行时刻。纯函数，不需要后台线程。
#[tauri::command]
pub async fn schedule_preview(
    frequency: Frequency,
    from: Option<String>,
    count: Option<usize>,
) -> Result<Vec<String>, String> {
    let now = match from.as_deref().filter(|text| !text.is_empty()) {
        Some(text) => model::parse_dt(text).ok_or_else(|| "SCHEDULE_INVALID_TIME".to_string())?,
        None => Local::now(),
    };
    Ok(model::preview(now, &frequency, count.unwrap_or(5)))
}

/// 前端执行完委托动作（刷新信息源 / 备份）后的回调。
/// 返回 false 表示这条 runId 已经过期（超时放弃过），调用方忽略即可。
#[tauri::command]
pub async fn schedule_action_result(
    run_id: String,
    ok: bool,
    note: Option<String>,
    error: Option<String>,
) -> Result<bool, String> {
    let result = if ok {
        Ok(Outcome { note })
    } else {
        Err(error.unwrap_or_else(|| "SCHEDULE_ACTION_FAILED".into()))
    };
    Ok(engine::get()?.complete_delegated(&run_id, result))
}
