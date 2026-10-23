import type { WorkItemStatus } from "./types";

/** 看板列的顺序：待办 → 进行中 → 已完成 → 已取消。
 *  顺序写死在这里，是为了「拖动改状态」的落点与列表页的状态下拉一致，
 *  不随数据里出现过的状态漂移（空列也要占位，否则拖到空列无处可放）。 */
export const BOARD_COLUMNS = ["todo", "doing", "done", "cancelled"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export interface BoardBuckets<T> {
  todo: T[];
  doing: T[];
  done: T[];
  cancelled: T[];
}

/**
 * 把（已经过滤/排序过的）工作项按状态分桶。
 * 桶内保持调用方给的顺序——列表页的「未完成在前、按截止日期」排序因此延续到看板，
 * 同一份筛选在两栏里看到的是同一批卡片。
 * 未知状态（数据被手改过）落到「待办」，不让卡片凭空消失。
 */
export function groupByStatus<T extends { status: string }>(items: readonly T[]): BoardBuckets<T> {
  const buckets: BoardBuckets<T> = { todo: [], doing: [], done: [], cancelled: [] };
  for (const item of items) {
    const column: BoardColumn = (BOARD_COLUMNS as readonly string[]).includes(item.status) ? (item.status as BoardColumn) : "todo";
    buckets[column].push(item);
  }
  return buckets;
}

/** 拖动/选择卡片后的写入值：同列不动，跨列就是目标列的状态。 */
export function nextStatusFor(current: WorkItemStatus, target: BoardColumn): WorkItemStatus | null {
  return current === target ? null : target;
}
