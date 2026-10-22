/** 定时任务的命令面。所有「下次运行时刻」都问 Rust，前端不算。 */
import { invoke } from "@tauri-apps/api/core";
import type { Frequency, HistoryEntry, Snapshot, Task, TaskInput } from "./core";

export function loadSnapshot(): Promise<Snapshot> {
    return invoke<Snapshot>("schedule_snapshot");
}

/** 新建传 id = ""；更新传已有 id。 */
export function saveTask(task: TaskInput & { id: string }): Promise<Task> {
    return invoke<Task>("schedule_save", { task });
}

export function deleteTask(id: string): Promise<void> {
    return invoke("schedule_delete", { id });
}

export function setTaskEnabled(id: string, enabled: boolean): Promise<Task | null> {
    return invoke<Task | null>("schedule_set_enabled", { id, enabled });
}

export function clearHistory(): Promise<void> {
    return invoke("schedule_clear_history");
}

/** 立即运行一次：等它跑完再返回，结果就是那一条历史。 */
export function runTaskNow(id: string): Promise<HistoryEntry> {
    return invoke<HistoryEntry>("schedule_run_now", { id });
}

/** 频率 → 接下来几次运行时刻（Rust 侧的纯函数） */
export function previewFrequency(frequency: Frequency, count = 5): Promise<string[]> {
    return invoke<string[]>("schedule_preview", { frequency, count });
}

/** 委托动作执行完毕的回调。返回 false 表示这条 runId 已经过期（Rust 侧已按超时记失败）。 */
export function reportActionResult(runId: string, ok: boolean, note?: string, error?: string): Promise<boolean> {
    return invoke<boolean>("schedule_action_result", { runId, ok, note: note ?? null, error: error ?? null });
}
