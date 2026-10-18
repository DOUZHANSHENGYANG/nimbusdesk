/**
 * 计划管理的撤销 / 重做。
 *
 * 设计取舍（都是踩过的坑）：
 *
 * 1. **快照式而不是命令式**。命令式（记「删了 id=X」再反向执行）要求每个操作
 *    都有精确的逆操作；一旦漏掉某个字段（比如 link、updatedAt），撤销之后数据
 *    就悄悄残了。快照存整份任务数组，代价是内存，收益是「撤销后与操作前逐字段
 *    相同」这个可以断言的强保证。
 *
 * 2. **只存 days，不存整个 store**。settings / fences 等与计划无关的状态混进来
 *    会导致「撤销一次任务勾选，顺带把主题也切回去了」这种荒谬行为。
 *
 * 3. **按天分片**。全量快照意味着一天 200 个任务时每次勾选都要序列化整棵树。
 *    真正需要恢复的粒度是「某一天的某一批任务」—— 所以快照按 date 存，
 *    恢复时只回填那一天。跨天操作（归档）由调用方作为一次事务提交。
 *
 * 4. **past 存「操作前」，future 存「操作后」**。
 *    这是最容易写错的一点：如果 past 和 future 都存「操作前」，
 *    撤销时把 past 的顶弹出到 future，future 里躺的是**同一个**前状态 ——
 *    于是「重做」把状态恢复成撤销前的那一刻，等于什么都没做。
 *    正确的做法是撤销时把**当前**状态快照进 future（见 popUndo），
 *    这样 future 天然存的是「操作后」。
 *    这个 bug 不会报错，只会让人觉得「重做键坏了」，所以有专门的测试。
 *
 * 5. **容量上限 + 清掉重做分支**。新操作会丢弃 redo 栈（标准行为：
 *    改了新东西之后，「重做」指向的未来已经不存在了）。
 */

import type { PlanTask, ArchivedDay } from "@/features/plans/types";

/** 一组「天 → 该天任务」的快照（null = 当时这天不存在，恢复时要删掉） */
export type DaySnapshot = Map<string, PlanTask[] | null>;

export interface Snapshot {
  days: DaySnapshot;
  archive?: Map<string, ArchivedDay | null>;
  /** 供 UI 显示的标签（i18n key，不是已翻译字符串） */
  label: string;
}

/** 历史上限。100 步（与 PaperTodo 同量级）：再多也不会有人按到 */
export const HISTORY_LIMIT = 100;

export interface HistoryState {
  past: Snapshot[];
  future: Snapshot[];
}

export const emptyHistory: HistoryState = { past: [], future: [] };

/** 深拷贝某几天的任务数组。用 structuredClone 而不是 JSON round-trip：
 *  后者会把 undefined 字段变成缺失，恢复出来的对象与原对象不完全相同。 */
function cloneDays(
  days: Record<string, PlanTask[]>,
  dates: Iterable<string>,
): DaySnapshot {
  const out: DaySnapshot = new Map();
  for (const date of new Set(dates)) {
    const list = days[date];
    out.set(date, list ? structuredClone(list) : null);
  }
  return out;
}

/**
 * 记录一次操作**前**的状态。
 *
 * 调用约定：先拍快照，再执行修改。顺序反了就会把修改后的状态当成「修改前」，
 * 撤销等于没撤销 —— 这种 bug 不会报错，只会让人觉得「撤销键坏了」。
 * 所以命名用 `pushBefore` 而不是 `push`，把顺序写进函数名。
 */
export function pushBefore(
  history: HistoryState,
  days: Record<string, PlanTask[]>,
  affectedDates: string[],
  label: string,
  archive?: Record<string, ArchivedDay>,
): HistoryState {
  const snap: Snapshot = { days: cloneDays(days, affectedDates), label };
  if (archive) snap.archive = cloneArchive(archive, affectedDates);
  const past = [...history.past, snap];
  // 超出上限时丢最老的（数组头部）
  if (past.length > HISTORY_LIMIT) past.shift();
  // 新操作让「重做」的未来失效
  return { past, future: [] };
}

/**
 * 取出要撤销的快照。
 *
 * `currentDays` 是**调用时刻**的 days：撤销时必须把它快照进 future，
 * 否则「重做」会回到同一个前状态（见文件头第 4 条）。
 * 快照的日期集合沿用被撤销那一步的 affectedDates —— 同一个操作的前后状态
 * 影响的必然是同一批日子（增删任务不会跨天搬家）。
 */
export function popUndo(
  history: HistoryState,
  currentDays: Record<string, PlanTask[]>,
  archive: Record<string, ArchivedDay> = {},
): { snapshot: Snapshot; next: HistoryState } | null {
  const snap = history.past[history.past.length - 1];
  if (!snap) return null;
  const redoSnap: Snapshot = {
    days: cloneDays(currentDays, snap.days.keys()),
    label: snap.label,
  };
  if (snap.archive) redoSnap.archive = cloneArchive(archive, snap.archive.keys());
  return {
    snapshot: snap,
    next: {
      past: history.past.slice(0, -1),
      future: [redoSnap, ...history.future],
    },
  };
}

/** 取出要重做的快照。同理，当前状态要回填进 past 才能再撤销。 */
export function popRedo(
  history: HistoryState,
  currentDays: Record<string, PlanTask[]>,
  archive: Record<string, ArchivedDay> = {},
): { snapshot: Snapshot; next: HistoryState } | null {
  const snap = history.future[0];
  if (!snap) return null;
  const undoSnap: Snapshot = {
    days: cloneDays(currentDays, snap.days.keys()),
    label: snap.label,
  };
  if (snap.archive) undoSnap.archive = cloneArchive(archive, snap.archive.keys());
  return {
    snapshot: snap,
    next: {
      past: [...history.past, undoSnap],
      future: history.future.slice(1),
    },
  };
}

/**
 * 把快照应用到 days（返回新对象，不改原对象）。
 *
 * 快照里值为 null 的天表示「当时这天不存在」，因此要**删除**而不是写空数组 ——
 * 写空数组会让日历/时间轴上凭空多出一个空日子。
 */
export function applySnapshot(
  days: Record<string, PlanTask[]>,
  snap: Snapshot,
): Record<string, PlanTask[]> {
  const next = { ...days };
  for (const [date, list] of snap.days) {
    if (list === null) delete next[date];
    else next[date] = structuredClone(list);
  }
  return next;
}

export const canUndo = (h: HistoryState) => h.past.length > 0;
function cloneArchive(archive: Record<string, ArchivedDay>, dates: Iterable<string>): Map<string, ArchivedDay | null> {
  return new Map([...dates].map(date => [date, archive[date] ? structuredClone(archive[date]) : null]));
}
export function applyArchiveSnapshot(archive: Record<string, ArchivedDay>, snap: Snapshot): Record<string, ArchivedDay> {
  const next = { ...archive };
  for (const [date, value] of snap.archive ?? []) { if (value === null) delete next[date]; else next[date] = structuredClone(value); }
  return next;
}
export const canRedo = (h: HistoryState) => h.future.length > 0;

/** 下一次撤销/重做的操作名（i18n key），用于按钮提示「撤销：勾选完成」 */
export const undoLabel = (h: HistoryState) => h.past[h.past.length - 1]?.label ?? null;
export const redoLabel = (h: HistoryState) => h.future[0]?.label ?? null;
