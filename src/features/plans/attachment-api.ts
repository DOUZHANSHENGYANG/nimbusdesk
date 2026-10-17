import { invoke } from "@tauri-apps/api/core";
import { openPath, pickFile, revealInExplorer } from "@/lib/tauri";
import { usePlans } from "@/features/plans/store";
import type { TaskAttachment } from "@/features/plans/types";

/** Re-read after file copying: another window can edit/delete a task while the picker is open. */
export async function addTaskAttachment(date: string, taskId: string): Promise<boolean> {
  const path = await pickFile();
  if (!path) return true;
  if (!usePlans.getState().days[date]?.some((task) => task.id === taskId)) return false;
  const added = await invoke<TaskAttachment[]>("task_attachments_add", { taskId, paths: [path] });
  const state = usePlans.getState();
  const task = state.days[date]?.find((entry) => entry.id === taskId);
  if (!task) return false;
  const merged = new Map((task.attachments ?? []).map((item) => [item.id, item]));
  for (const item of added) merged.set(item.id, item);
  state.updateTask(date, taskId, { attachments: [...merged.values()] });
  return true;
}

export function unlinkTaskAttachment(date: string, taskId: string, id: string) {
  const state = usePlans.getState();
  const task = state.days[date]?.find((entry) => entry.id === taskId);
  if (task) state.updateTask(date, taskId, { attachments: task.attachments?.filter((item) => item.id !== id) });
}

export async function openTaskAttachment(attachment: TaskAttachment, reveal = false) {
  const path = await invoke<string>("task_attachment_location", { path: attachment.path });
  await (reveal ? revealInExplorer(path) : openPath(path));
}

export function attachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
