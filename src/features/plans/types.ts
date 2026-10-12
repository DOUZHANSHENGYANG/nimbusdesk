/** 计划管理数据模型与树工具 */

export type TaskStatus = "todo" | "doing" | "done";

export interface PlanTask {
  id: string;
  /** null = 顶层计划；否则为父任务 id */
  parentId: string | null;
  title: string;
  note?: string;
  /** HH:mm，可空 */
  time?: string;
  status: TaskStatus;
  createdAt: number;
}

export interface ArchivedDay {
  archivedAt: number;
  tasks: PlanTask[];
}

export type PlanTaskPatch = Partial<Pick<PlanTask, "title" | "note" | "time" | "status">>;

/** 某日直接子任务（保持数组顺序） */
export function childrenOf(tasks: PlanTask[], parentId: string | null): PlanTask[] {
  return tasks.filter((t) => t.parentId === parentId);
}

/** 收集某任务及其全部后代 id（级联删除用） */
export function subtreeIds(tasks: PlanTask[], id: string): Set<string> {
  const ids = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tasks) {
      if (t.parentId && ids.has(t.parentId) && !ids.has(t.id)) {
        ids.add(t.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** 子树完成进度（不含自身） */
export function subtreeProgress(tasks: PlanTask[], id: string): { done: number; total: number } {
  const ids = subtreeIds(tasks, id);
  let done = 0;
  let total = 0;
  for (const t of tasks) {
    if (t.id !== id && ids.has(t.id)) {
      total++;
      if (t.status === "done") done++;
    }
  }
  return { done, total };
}

/** 统计某日完成进度 */
export function dayProgress(tasks: PlanTask[]): { done: number; total: number } {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  return { done, total };
}

/** 本地日期 YYYY-MM-DD */
export function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayStr(): string {
  return fmtDate(new Date());
}

export function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return fmtDate(dt);
}

export function parseDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}
