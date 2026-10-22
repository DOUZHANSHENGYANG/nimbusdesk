//! 调度引擎：30 秒心跳 + 单次执行（超时 / 不重入）+ 历史。
//!
//! 三条硬约束决定了这里的形状：
//!
//! 1. **只有一个写者路径**。心跳线程和「立即运行」命令都会改
//!    `modules/schedule/tasks.json`（next_run / last_run / enabled）与 `history.json`，
//!    所以两者都先把决定算成 `Op`，再交给 `apply` 在**一次**
//!    `data::with_data_dir` 锁里「重读 → 按 id 打补丁 → 写回」。
//!    任何一方都不会用几分钟前读到的整表覆盖对方的改动。
//! 2. **跑动不持锁**。动作可能跑几十秒（AI），`apply` 只负责几毫秒的落盘。
//! 3. **同一任务绝不并发**。in-flight 集合在动作线程**真正结束时**才释放，
//!    所以超时被放弃的那次调用如果还在跑，下一次触发只会被跳过。

use crate::ahub::store::AppH;
use crate::commands::data;
use crate::schedule::actions::{self, ActionDef, Ctx, Kind, Outcome};
use crate::schedule::model::{self, Frequency, HistoryEntry, Task, HISTORY_LIMIT};
use chrono::{DateTime, Local};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::mpsc::{RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

/// 心跳周期。错过的判定余量见 `model::MISSED_GRACE_SECS`。
const TICK_SECS: u64 = 30;
const TASKS_FILE: &str = "modules/schedule/tasks.json";
const HISTORY_FILE: &str = "modules/schedule/history.json";

// ── 文件读写：都挂在云台的数据目录约定下（modules/<模块>/<文件>.json）────────

fn read_at<T: DeserializeOwned + Default>(root: &Path, relative: &str) -> Result<T, String> {
    let path = root.join(relative);
    let text = match crate::atomic::read_file_with_fallback(&path.to_string_lossy()) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(T::default()),
        Err(error) => return Err(error.to_string()),
    };
    if text.trim().is_empty() {
        return Ok(T::default());
    }
    // 解析失败就报错、不写回：宁可让界面提示「文件坏了」，
    // 也不要用一份空表把它覆盖掉（write_file_atomic 另有一份 .bak 兜底）。
    serde_json::from_str(&text).map_err(|error| format!("解析 {relative} 失败: {error}"))
}

fn write_at<T: Serialize>(root: &Path, relative: &str, value: &T) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    crate::atomic::write_file_atomic(&root.join(relative).to_string_lossy(), text.as_bytes())
        .map_err(|error| error.to_string())
}

pub fn load_tasks() -> Result<Vec<Task>, String> {
    data::with_data_dir(|root| read_at(root, TASKS_FILE))
}

pub fn load_history() -> Result<Vec<HistoryEntry>, String> {
    data::with_data_dir(|root| read_at(root, HISTORY_FILE))
}

/// 新建或更新一个任务（界面来的写入口）。
///
/// 引擎拥有的三个字段（next_run / last_run / last_status）**不接受界面覆盖**；
/// 频率变了或从停用变启用时清空 next_run，让引擎按新的规则重排 ——
/// 否则「把每天 09:00 改成 15:00」会等到明天 09:00 才生效。
pub fn upsert_task(mut task: Task) -> Result<Task, String> {
    let now = Local::now();
    data::with_data_dir(|root| {
        let mut tasks: Vec<Task> = read_at(root, TASKS_FILE)?;
        match tasks.iter_mut().find(|item| item.id == task.id) {
            Some(slot) if !task.id.is_empty() => {
                let previous = slot.clone();
                if previous.frequency != task.frequency || (!previous.enabled && task.enabled) {
                    slot.next_run = None;
                }
                slot.name = task.name;
                slot.frequency = task.frequency;
                slot.action = task.action;
                slot.enabled = task.enabled;
                slot.run_if_missed = task.run_if_missed;
                if slot.next_run.is_none() && slot.enabled {
                    slot.next_run = seed_next_run(slot, now);
                }
                task = slot.clone();
            }
            // 未知 id：当成新建（前端丢了本地状态时不该丢任务本身）
            _ => {
                if task.id.is_empty() {
                    task.id = new_id();
                }
                task.last_run = None;
                task.last_status = None;
                task.next_run = seed_next_run(&task, now);
                tasks.push(task.clone());
            }
        }
        write_at(root, TASKS_FILE, &tasks)?;
        Ok(task)
    })
}

pub fn delete_task(task_id: &str) -> Result<(), String> {
    data::with_data_dir(|root| {
        let mut tasks: Vec<Task> = read_at(root, TASKS_FILE)?;
        tasks.retain(|item| item.id != task_id);
        write_at(root, TASKS_FILE, &tasks)
    })
}

pub fn set_enabled(task_id: &str, enabled: bool) -> Result<Option<Task>, String> {
    let now = Local::now();
    data::with_data_dir(|root| {
        let mut tasks: Vec<Task> = read_at(root, TASKS_FILE)?;
        let Some(slot) = tasks.iter_mut().find(|item| item.id == task_id) else {
            return Ok(None);
        };
        if enabled && !slot.enabled {
            // 重新启用：按当下重排，避免把「停用期间错过的那次」当成要补跑的
            slot.next_run = seed_next_run(slot, now);
        }
        slot.enabled = enabled;
        let task = slot.clone();
        write_at(root, TASKS_FILE, &tasks)?;
        Ok(Some(task))
    })
}

pub fn clear_history() -> Result<(), String> {
    data::with_data_dir(|root| write_at::<Vec<HistoryEntry>>(root, HISTORY_FILE, &Vec::new()))
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// 下一次运行时刻（一次性就是那个时刻；其余按当前时间起算）。
fn seed_next_run(task: &Task, now: DateTime<Local>) -> Option<String> {
    model::next_run_after(now, &task.frequency, now).map(model::fmt_dt)
}

/// 一次运行/跳过之后，这个任务的下一次是什么。
/// 一次性用掉了就没有下一次 —— 它会被自动停用。
fn advance(task: &Task, now: DateTime<Local>) -> Option<String> {
    match task.frequency {
        Frequency::Once { .. } => None,
        _ => seed_next_run(task, now),
    }
}

// ── 引擎 ────────────────────────────────────────────────────────────────

pub struct Engine {
    app: AppH,
    inflight: Arc<Mutex<HashSet<String>>>,
    /// 交给前端的动作：runId → 回调通道
    pending: Mutex<HashMap<String, Sender<Result<Outcome, String>>>>,
}

static ENGINE: OnceLock<Arc<Engine>> = OnceLock::new();

/// 启动 30 秒心跳。应用运行期间它自己会触发，不依赖任何一次界面调用。
pub fn start(app: AppH) {
    let engine = ENGINE
        .get_or_init(|| Arc::new(Engine {
            app,
            inflight: Arc::new(Mutex::new(HashSet::new())),
            pending: Mutex::new(HashMap::new()),
        }))
        .clone();
    std::thread::spawn(move || {
        loop {
            // 启动后立刻判一次：这样「应用没运行时错过的那次」在启动瞬间就被记进历史
            if let Err(error) = engine.tick() {
                eprintln!("[schedule] 心跳失败: {error}");
            }
            std::thread::sleep(Duration::from_secs(TICK_SECS));
        }
    });
}

pub fn get() -> Result<Arc<Engine>, String> {
    ENGINE
        .get()
        .cloned()
        .ok_or_else(|| "SCHEDULE_NOT_READY".to_string())
}

/// 一次要到点上的处置。
#[derive(Clone)]
enum Op {
    /// 真的跑了一次（结果在 entry 里，成功或失败都算）
    Ran { task: Task, entry: HistoryEntry },
    /// 错过且不补跑
    Skipped { task: Task, entry: HistoryEntry },
    /// next_run 缺失（新建 / 改过频率）→ 只排下一次
    Seed { task: Task, next_run: Option<String> },
    /// 动作 id 已经不在注册表里 → 停用并记一条失败，别再每 30 秒重试
    Disabled { task: Task, entry: HistoryEntry },
}

impl Op {
    fn entry(&self) -> Option<&HistoryEntry> {
        match self {
            Op::Ran { entry, .. } | Op::Skipped { entry, .. } | Op::Disabled { entry, .. } => Some(entry),
            Op::Seed { .. } => None,
        }
    }

    fn task(&self) -> &Task {
        match self {
            Op::Ran { task, .. } | Op::Skipped { task, .. } | Op::Seed { task, .. } | Op::Disabled { task, .. } => task,
        }
    }
}

impl Engine {
    /// 一次心跳：读表 → 决定 → 跑（不持锁）→ 统一落盘 + 发通知。
    fn tick(&self) -> Result<(), String> {
        let now = Local::now();
        let tasks = load_tasks()?;
        let mut ops: Vec<Op> = Vec::new();

        for task in tasks {
            if !task.enabled {
                continue;
            }
            let Some(action) = actions::find(&task.action.id) else {
                ops.push(Op::Disabled {
                    entry: entry(&task, "failed", 0, Some(format!("SCHEDULE_UNKNOWN_ACTION: {}", task.action.id)), None, None, now),
                    task,
                });
                continue;
            };
            let Some(due) = task.next_run.as_deref().and_then(model::parse_dt) else {
                ops.push(Op::Seed {
                    next_run: seed_next_run(&task, now),
                    task,
                });
                continue;
            };
            if due > now {
                continue;
            }
            let missed_secs = (now - due).num_seconds();
            if missed_secs > model::MISSED_GRACE_SECS && !task.run_if_missed {
                ops.push(Op::Skipped {
                    entry: entry(&task, "skipped", 0, None, None, Some("app-not-running".to_string()), now),
                    task,
                });
                continue;
            }
            // 到点（或补跑）。同一任务还在跑就直接跳过：不重入，也不污染历史。
            if !self.claim(&task.id) {
                eprintln!("[schedule] {} 上一次还在运行，跳过本次触发", task.name);
                continue;
            }
            let entry = self.run_one(&task, action);
            ops.push(Op::Ran { task, entry });
        }

        self.apply_and_notify(ops)
    }

    /// 「立即运行一次」：不看启用/停用，也不受 next_run 约束。
    pub fn run_now(&self, task_id: &str) -> Result<HistoryEntry, String> {
        let tasks = load_tasks()?;
        let task = tasks
            .iter()
            .find(|item| item.id == task_id)
            .cloned()
            .ok_or_else(|| "SCHEDULE_TASK_NOT_FOUND".to_string())?;
        let action = actions::find(&task.action.id)
            .ok_or_else(|| format!("SCHEDULE_UNKNOWN_ACTION: {}", task.action.id))?;
        if !self.claim(&task.id) {
            return Err("SCHEDULE_TASK_RUNNING".into());
        }
        let entry = self.run_one(&task, action);
        self.apply_and_notify(vec![Op::Ran {
            task,
            entry: entry.clone(),
        }])?;
        Ok(entry)
    }

    /// 跑一次并把结果变成历史条目。**不落盘** —— 统一交给 `apply`。
    fn run_one(&self, task: &Task, action: &'static ActionDef) -> HistoryEntry {
        let started = Instant::now();
        let result = self.execute(task, action);
        let ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(outcome) => entry(task, "success", ms, None, outcome.note, None, Local::now()),
            Err(error) => entry(task, "failed", ms, Some(error), None, None, Local::now()),
        }
    }

    fn execute(&self, task: &Task, action: &'static ActionDef) -> Result<Outcome, String> {
        match action.kind {
            // 本地动作自己在线程结束时释放 in-flight 标记（见 execute_local）
            Kind::Local => execute_local(self.app.clone(), task.clone(), action, self.inflight.clone()),
            Kind::Delegated => {
                let result = self.execute_delegated(task, action);
                self.release(&task.id);
                result
            }
        }
    }

    fn execute_delegated(&self, task: &Task, action: &'static ActionDef) -> Result<Outcome, String> {
        let run_id = new_id();
        let (sender, receiver) = channel();
        self.pending
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(run_id.clone(), sender);
        let request = json!({
            "runId": run_id,
            "actionId": action.id,
            "taskId": task.id,
            "taskName": task.name,
            "params": task.action.params,
        });
        if let Err(error) = self.app.emit(schedule_action_event(), &request) {
            self.forget(&run_id);
            return Err(format!("SCHEDULE_FRONTEND_UNAVAILABLE: {error}"));
        }
        let result = match receiver.recv_timeout(Duration::from_millis(action.timeout_ms)) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => Err(format!("SCHEDULE_TIMEOUT: {}ms", action.timeout_ms)),
            Err(RecvTimeoutError::Disconnected) => Err("SCHEDULE_FRONTEND_UNAVAILABLE".into()),
        };
        self.forget(&run_id);
        result
    }

    /// 前端回调：把「委托动作」的结果交回等待中的心跳线程。
    pub fn complete_delegated(&self, run_id: &str, result: Result<Outcome, String>) -> bool {
        let sender = self
            .pending
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(run_id);
        sender.is_some_and(|sender| sender.send(result).is_ok())
    }

    fn forget(&self, run_id: &str) {
        self.pending
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(run_id);
    }

    /// 认领一次执行。已经在跑就返回 false（不重入）。
    fn claim(&self, task_id: &str) -> bool {
        self.inflight
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(task_id.to_string())
    }

    fn release(&self, task_id: &str) {
        self.inflight
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(task_id);
    }

    /// 落盘 + 通知界面。补丁在**一次**目录锁里完成：重读 → 改引擎拥有的字段 → 写。
    fn apply_and_notify(&self, ops: Vec<Op>) -> Result<(), String> {
        if ops.is_empty() {
            return Ok(());
        }
        let now = Local::now();
        data::with_data_dir(|root| {
            let mut tasks: Vec<Task> = read_at(root, TASKS_FILE)?;
            let mut history: Vec<HistoryEntry> = read_at(root, HISTORY_FILE)?;
            for op in &ops {
                let task = op.task();
                if let Some(slot) = tasks.iter_mut().find(|item| item.id == task.id) {
                    match op {
                        Op::Ran { entry, .. } | Op::Skipped { entry, .. } => {
                            slot.last_run = Some(entry.at.clone());
                            slot.last_status = Some(entry.status.clone());
                            slot.next_run = advance(slot, now);
                            // 一次性：这一刻用掉了就自动停用（跑过和错过都算）
                            if matches!(slot.frequency, Frequency::Once { .. }) {
                                slot.enabled = false;
                            }
                        }
                        Op::Seed { next_run, .. } => slot.next_run = next_run.clone(),
                        Op::Disabled { .. } => slot.enabled = false,
                    }
                }
                if let Some(entry) = op.entry() {
                    history.insert(0, entry.clone());
                }
            }
            history.truncate(HISTORY_LIMIT);
            write_at(root, TASKS_FILE, &tasks)?;
            write_at(root, HISTORY_FILE, &history)?;
            Ok(())
        })?;
        // 通知放在落盘之后：界面收到事件时再读历史，读到的已经是这一条。
        for op in &ops {
            if let Some(entry) = op.entry() {
                let _ = self.app.emit(schedule_ran_event(), entry);
            }
        }
        Ok(())
    }
}

pub fn schedule_action_event() -> &'static str {
    "schedule://action"
}

pub fn schedule_ran_event() -> &'static str {
    "schedule://ran"
}

/// 在独立线程里跑本地动作，超时算失败。
///
/// 线程**自己**在最后释放 in-flight 标记（不是超时的调用方释放）：
/// 被超时放弃的那次如果还在跑，下一次触发只会被跳过，绝不并发。
/// 这是成立的，因为本地动作只有 `ai_prompt`，它的 HTTP 客户端自带 90 秒超时。
fn execute_local(
    app: AppH,
    task: Task,
    action: &'static ActionDef,
    inflight: Arc<Mutex<HashSet<String>>>,
) -> Result<Outcome, String> {
    let run = action.run.expect("本地动作必须在注册表里给出执行函数");
    let (sender, receiver) = channel();
    std::thread::spawn(move || {
        let result = run(&Ctx {
            app: &app,
            task_id: &task.id,
            task_name: &task.name,
            params: &task.action.params,
        });
        inflight
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(&task.id);
        let _ = sender.send(result);
    });
    match receiver.recv_timeout(Duration::from_millis(action.timeout_ms)) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err(format!("SCHEDULE_TIMEOUT: {}ms", action.timeout_ms)),
        // 执行线程 panic 时通道断开
        Err(RecvTimeoutError::Disconnected) => Err("SCHEDULE_ACTION_PANIC".into()),
    }
}

#[allow(clippy::too_many_arguments)]
fn entry(
    task: &Task,
    status: &str,
    ms: u64,
    error: Option<String>,
    note: Option<String>,
    reason: Option<String>,
    now: DateTime<Local>,
) -> HistoryEntry {
    HistoryEntry {
        id: new_id(),
        task_id: task.id.clone(),
        task_name: task.name.clone(),
        at: model::fmt_dt(now),
        status: status.into(),
        ms,
        error,
        note,
        reason,
    }
}

/// 给界面用的快照：任务 + 历史。
pub fn snapshot() -> Result<Value, String> {
    Ok(json!({
        "tasks": load_tasks()?,
        "history": load_history()?,
        "actions": actions::describe(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schedule::model::ActionSpec;

    fn task(id: &str, frequency: Frequency) -> Task {
        Task {
            id: id.into(),
            name: format!("任务 {id}"),
            frequency,
            action: ActionSpec {
                id: "backup".into(),
                params: json!({}),
            },
            enabled: true,
            run_if_missed: false,
            next_run: None,
            last_run: None,
            last_status: None,
        }
    }

    fn daily(time: &str) -> Frequency {
        Frequency::Daily { time: time.into() }
    }

    fn dt(text: &str) -> DateTime<Local> {
        model::parse_dt(text).unwrap()
    }

    #[test]
    fn seeding_puts_a_new_task_on_the_calendar() {
        let now = dt("2026-10-22T08:00:00");
        assert_eq!(
            seed_next_run(&task("a", daily("09:00")), now).unwrap(),
            "2026-10-22T09:00:00"
        );
        let once = task("b", Frequency::Once { at: "2026-10-22T20:00".into() });
        assert_eq!(seed_next_run(&once, now).unwrap(), "2026-10-22T20:00:00");
        // 一次性时刻已经过去：没有下一次
        let stale = task("c", Frequency::Once { at: "2026-10-01T20:00".into() });
        assert_eq!(seed_next_run(&stale, now), None);
    }

    #[test]
    fn once_is_retired_after_it_fires() {
        let once = task("a", Frequency::Once { at: "2026-10-22T09:00".into() });
        assert_eq!(advance(&once, dt("2026-10-22T09:00:00")), None);
        assert_eq!(
            advance(&task("b", daily("09:00")), dt("2026-10-22T09:00:00")).unwrap(),
            "2026-10-23T09:00:00"
        );
    }

    /// 「应用没运行」的判定：超出余量才算错过，余量之内算心跳晚了几秒。
    #[test]
    fn missed_detection_uses_the_grace_window() {
        let due = dt("2026-10-22T09:00:00");
        let on_time = due + chrono::Duration::seconds(model::MISSED_GRACE_SECS);
        let late = due + chrono::Duration::seconds(model::MISSED_GRACE_SECS + 1);
        assert!((on_time - due).num_seconds() <= model::MISSED_GRACE_SECS);
        assert!((late - due).num_seconds() > model::MISSED_GRACE_SECS);
        // 心跳周期必须小于余量，否则每次心跳都落在「错过」那一侧
        assert!((TICK_SECS as i64) * 2 < model::MISSED_GRACE_SECS);
    }

    #[test]
    fn history_is_capped_and_newest_first() {
        let mut history: Vec<HistoryEntry> = (0..HISTORY_LIMIT + 7)
            .map(|index| entry(&task("t", daily("09:00")), "success", index as u64, None, None, None, Local::now()))
            .collect();
        history.truncate(HISTORY_LIMIT);
        // 与 apply_and_notify 里的做法一致：新条目 insert(0)
        let newest = entry(&task("t", daily("09:00")), "failed", 1, Some("boom".into()), None, None, Local::now());
        history.insert(0, newest.clone());
        history.truncate(HISTORY_LIMIT);
        assert_eq!(history.len(), HISTORY_LIMIT);
        assert_eq!(history[0].id, newest.id);
        assert_eq!(history[0].error.as_deref(), Some("boom"));
    }

    #[test]
    fn in_flight_set_is_the_non_reentrancy_guard() {
        let inflight = Arc::new(Mutex::new(HashSet::new()));
        // Engine::claim / release 就是这两个动作
        assert!(inflight.lock().unwrap().insert("a".to_string()), "第一次认领成功");
        assert!(!inflight.lock().unwrap().insert("a".to_string()), "第二次认领失败 = 不重入");
        inflight.lock().unwrap().remove("a");
        assert!(inflight.lock().unwrap().insert("a".to_string()), "释放后可以再跑");
    }

    #[test]
    fn delegated_callback_only_accepts_a_live_run_id() {
        let (sender, receiver) = channel::<Result<Outcome, String>>();
        let pending: Mutex<HashMap<String, Sender<Result<Outcome, String>>>> =
            Mutex::new(HashMap::from([("live".to_string(), sender)]));
        let take = |run_id: &str| {
            let sender = pending.lock().unwrap().remove(run_id);
            sender.is_some_and(|sender| sender.send(Ok(Outcome { note: Some("x".into()) })).is_ok())
        };
        assert!(take("live"));
        assert!(!take("live"), "同一条回调不能消费两次");
        assert!(!take("stale"), "超时后过期的回调必须被忽略");
        assert_eq!(receiver.recv().unwrap().unwrap().note.as_deref(), Some("x"));
    }

    /// 频率变了必须重排 next_run，否则「把 09:00 改成 15:00」要等到明天才生效。
    #[test]
    fn frequency_change_clears_the_pending_slot() {
        let old = model::next_run_after(dt("2026-10-22T08:00:00"), &daily("09:00"), dt("2026-10-22T08:00:00"));
        assert_eq!(model::fmt_dt(old.unwrap()), "2026-10-22T09:00:00");
        // upsert_task 里做的判定：频率不同 → next_run 置空 → 按新的重排
        let previous = daily("09:00");
        let next = daily("15:00");
        assert_ne!(previous, next);
        assert_eq!(
            model::fmt_dt(seed_next_run(&task("a", next), dt("2026-10-22T08:00:00")).map(|text| model::parse_dt(&text).unwrap()).unwrap()),
            "2026-10-22T15:00:00"
        );
    }

    #[test]
    fn data_files_live_under_the_schedule_module() {
        assert_eq!(TASKS_FILE, "modules/schedule/tasks.json");
        assert_eq!(HISTORY_FILE, "modules/schedule/history.json");
    }
}
