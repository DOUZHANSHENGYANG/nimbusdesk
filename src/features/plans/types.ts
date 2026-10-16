/** 计划管理数据模型与树工具 */

export type TaskStatus = "todo" | "doing" | "done";

export interface PlanTask {
  id: string;
  /** null = 顶层计划；否则为父任务 id */
  parentId: string | null;
  title: string;
  note?: string;
  /** 开始时间 HH:mm，可空 */
  start?: string;
  /** 结束时间 HH:mm，可空。与 start 成对出现才构成时间范围 */
  end?: string;
  /**
   * 唯一由用户直接设置的状态：点一下勾选即完成。
   * 「进行中」是推导出来的（见 statusOf），不落盘 ——
   * 因此到点自动变进行中不需要任何定时器去改数据。
   */
  done: boolean;
  createdAt: number;
}

export interface ArchivedDay {
  archivedAt: number;
  tasks: PlanTask[];
}

export type PlanTaskPatch = Partial<Pick<PlanTask, "title" | "note" | "start" | "end" | "done">>;

/* ── 时间 ─────────────────────────────────────────────── */

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:mm" → 当日分钟数；非法或空返回 null */
export function minutesOf(hhmm?: string): number | null {
  if (!hhmm) return null;
  const m = HHMM_RE.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 当日分钟数 → "HH:mm" */
export function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 是否构成合法时间范围（两端都有且 end > start） */
export function hasRange(task: Pick<PlanTask, "start" | "end">): boolean {
  const s = minutesOf(task.start);
  const e = minutesOf(task.end);
  return s != null && e != null && e > s;
}

/** 时间范围展示文本，如 "09:00 – 11:30"；无范围返回 null */
export function rangeLabel(task: Pick<PlanTask, "start" | "end">): string | null {
  if (!hasRange(task)) return null;
  return `${task.start} – ${task.end}`;
}

/** 时长文本，如 "2 小时 30 分" / "45 分"；无范围返回 null */
export function rangeDuration(task: Pick<PlanTask, "start" | "end">): number | null {
  const s = minutesOf(task.start);
  const e = minutesOf(task.end);
  if (s == null || e == null || e <= s) return null;
  return e - s;
}

/* ── 状态推导 ─────────────────────────────────────────── */

/**
 * 任务在给定日期下的状态。
 *
 * - done：用户手动勾选，唯一可直接设置的状态
 * - doing：仅当「任务属于今天」且「当前时刻落在 [start, end) 内」时成立
 * - todo：其余情况（含没设时间范围的任务 —— 它们永远保持待办直到手动完成）
 *
 * 纯函数：now 由调用方传入，配合 useNow() 定期重算即可实现「到点自动开始」。
 */
export function statusOf(
  task: Pick<PlanTask, "done" | "start" | "end">,
  date: string,
  now: Date = new Date(),
): TaskStatus {
  if (task.done) return "done";
  if (date !== fmtDate(now)) return "todo";
  const s = minutesOf(task.start);
  const e = minutesOf(task.end);
  if (s == null || e == null || e <= s) return "todo";
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur >= s && cur < e ? "doing" : "todo";
}

/* ── 树工具 ───────────────────────────────────────────── */

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
      if (t.done) done++;
    }
  }
  return { done, total };
}

/** 统计某日完成进度（按落盘的 done 计，与时间推导无关） */
export function dayProgress(tasks: PlanTask[]): { done: number; total: number } {
  return { total: tasks.length, done: tasks.filter((t) => t.done).length };
}

/* ── 日期 ─────────────────────────────────────────────── */

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

/* ── 日期区间（归档筛选等用） ─────────────────────────── */

export interface DateRange {
  /** 起（含），YYYY-MM-DD；null = 不限 */
  from: string | null;
  /** 止（含），YYYY-MM-DD；null = 不限 */
  to: string | null;
}

/** 日期是否落在区间内（两端都含）。字符串比较即可 —— YYYY-MM-DD 字典序 = 时间序 */
export function inRange(date: string, range: DateRange): boolean {
  if (range.from && date < range.from) return false;
  if (range.to && date > range.to) return false;
  return true;
}

/** 区间天数（含两端）；任一端为空返回 null */
export function rangeDays(range: DateRange): number | null {
  if (!range.from || !range.to) return null;
  const ms = parseDate(range.to).getTime() - parseDate(range.from).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

/** 相对今天的常用区间。周一为一周起点（与日历视图一致） */
export function presetRange(
  preset: "today" | "week" | "month" | "last7" | "last30",
  now: Date = new Date(),
): DateRange {
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const shift = (d: Date, delta: number) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta);

  switch (preset) {
    case "today":
      return { from: fmtDate(base), to: fmtDate(base) };
    case "week": {
      const offset = (base.getDay() + 6) % 7; // 周一为首
      const mon = shift(base, -offset);
      return { from: fmtDate(mon), to: fmtDate(shift(mon, 6)) };
    }
    case "month": {
      const first = new Date(base.getFullYear(), base.getMonth(), 1);
      const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
      return { from: fmtDate(first), to: fmtDate(last) };
    }
    case "last7":
      return { from: fmtDate(shift(base, -6)), to: fmtDate(base) };
    case "last30":
      return { from: fmtDate(shift(base, -29)), to: fmtDate(base) };
  }
}

/** 某月的日历网格（42 格，周一为首），格内含是否属于本月 */
export function monthGrid(
  year: number,
  month: number,
): { date: string; inMonth: boolean }[] {
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - startOffset);
  const cells: { date: string; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({ date: fmtDate(d), inMonth: d.getMonth() === month });
  }
  return cells;
}

/** 该月第一天 / 最后一天的 YYYY-MM-DD */
export function monthBounds(year: number, month: number): { from: string; to: string } {
  return {
    from: fmtDate(new Date(year, month, 1)),
    to: fmtDate(new Date(year, month + 1, 0)),
  };
}
