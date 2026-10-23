import { shiftDate } from "./core";
import { BOARD_COLUMNS } from "./board-core";

/**
 * 总览视图的聚合逻辑。全部是纯函数：输入是已经过滤好的一批工作项，
 * 输出是百分比与分桶。不要把「哪一批」算在里面——范围与迭代筛选留在页面里，
 * 这里只管「给定这批怎么概括」，这样单测不用造 store，也保证看板与总览对同一批数据的口径一致。
 */

export interface StatusCounts {
  todo: number; doing: number; done: number; cancelled: number;
  /** 全部（含已取消），进度条的分母 */
  total: number;
  /** 未完成 = 待办 + 进行中，项目列表里靠它排序 */
  open: number;
}

export function statusCounts(items: readonly { status: string }[]): StatusCounts {
  const counts: Record<string, number> = { todo: 0, doing: 0, done: 0, cancelled: 0 };
  for (const item of items) {
    // 未知状态算待办，宁可多显示一条，也别让它在统计里消失。
    counts[(BOARD_COLUMNS as readonly string[]).includes(item.status) ? item.status : "todo"] += 1;
  }
  return {
    todo: counts.todo, doing: counts.doing, done: counts.done, cancelled: counts.cancelled,
    total: items.length, open: counts.todo + counts.doing,
  };
}

/** 完成率（整数百分比）：分母剔掉「已取消」，否则取消得越多完成率越好看。 */
export function completionRate(counts: StatusCounts): number {
  const denominator = counts.total - counts.cancelled;
  return denominator > 0 ? Math.round((counts.done / denominator) * 100) : 0;
}

export interface AttentionBuckets<T> { overdue: T[]; today: T[]; soon: T[] }

/**
 * 需要关注的三个桶：已逾期 / 今天截止 / 未来 soonDays 天内。
 * 已完成与已取消不算「需要关注」，没有截止日期的也不进桶（这类在「未排期」里看）。
 * 桶内按日期升序，同日期保持调用方给的顺序。
 */
export function needsAttention<T extends { status: string; deadline: string | null }>(
  items: readonly T[], today: string, soonDays = 7,
): AttentionBuckets<T> {
  const soonUntil = shiftDate(today, soonDays);
  const result: AttentionBuckets<T> = { overdue: [], today: [], soon: [] };
  for (const item of items) {
    if (item.status === "done" || item.status === "cancelled" || !item.deadline) continue;
    if (item.deadline < today) result.overdue.push(item);
    else if (item.deadline === today) result.today.push(item);
    else if (item.deadline <= soonUntil) result.soon.push(item);
  }
  const byDate = (a: T, b: T) => (a.deadline ?? "").localeCompare(b.deadline ?? "");
  result.overdue.sort(byDate); result.today.sort(byDate); result.soon.sort(byDate);
  return result;
}

export interface ProgressRow<T> { key: string; counts: StatusCounts; items: T[] }

/** 按调用方给的 key 分组（项目 / 业务范围 / 无项目），未完成多的排前面，其次总数、key。 */
export function groupProgress<T extends { status: string }>(items: readonly T[], keyOf: (item: T) => string): ProgressRow<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = groups.get(key);
    if (list) list.push(item); else groups.set(key, [item]);
  }
  return [...groups]
    .map(([key, groupItems]) => ({ key, counts: statusCounts(groupItems), items: groupItems }))
    .sort((a, b) => b.counts.open - a.counts.open || b.counts.total - a.counts.total || a.key.localeCompare(b.key));
}

/** 最近改动的若干条（按 updatedAt 倒序）。 */
export function recentlyUpdated<T extends { updatedAt: number }>(items: readonly T[], limit = 5): T[] {
  return [...items].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(0, limit));
}
