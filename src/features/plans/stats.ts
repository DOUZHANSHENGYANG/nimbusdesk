/**
 * 计划管理的统计聚合。
 *
 * 全部是纯函数 —— 输入「日期 → 任务数组」与窗口参数，输出可渲染的数字。
 * 这样指标口径可以脱离 DOM 直接断言，也避免把聚合逻辑写进 JSX。
 *
 * 数据来源有两处（活跃库 + 归档库），调用方负责先合并成一张表；
 * 本模块不知道数据从哪来，因此「跨库统计」也不需要任何特判。
 */

import { addDays, hasRange, parseDate, statusOf, type PlanTask } from "@/features/plans/types";

/** 日期 → 任务数组（活跃库与归档库合并后的形态） */
export type DayMap = Record<string, PlanTask[] | undefined>;

/** 取某日的任务（缺失返回空数组，避免到处写 `?? []`） */
export function tasksOn(days: DayMap, date: string): PlanTask[] {
  return days[date] ?? [];
}

/**
 * 把活跃库（`{日期: PlanTask[]}`）与归档库（`{日期: {archivedAt, tasks}}`）
 * 合并成一张表。
 *
 * 冲突时**活跃库优先**：同一天不可能同时在两处，但如果因为异常数据真的重了，
 * 活跃库那份才是用户此刻能编辑的。
 */
export function mergeDayMaps(
  active: Record<string, PlanTask[] | undefined>,
  archived: Record<string, { archivedAt: number; tasks: PlanTask[] } | undefined>,
): DayMap {
  const out: DayMap = {};
  for (const [date, entry] of Object.entries(archived)) {
    if (entry?.tasks?.length) out[date] = entry.tasks;
  }
  for (const [date, tasks] of Object.entries(active)) {
    if (tasks?.length) out[date] = tasks;
  }
  return out;
}

/** 闭区间 [from, to] 的全部日期（升序）。to 早于 from 时返回空数组 */
export function dateSpan(from: string, to: string): string[] {
  const out: string[] = [];
  if (from > to) return out;
  let cur = from;
  // 上限兜底：即使传入反向的极端参数也不至于死循环
  for (let i = 0; cur <= to && i < 3660; i++) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

export interface RangeStats {
  /** 区间内的任务总数（含已完成） */
  total: number;
  done: number;
  /** 完成率 0–1；无任务时为 null（避免把「没安排」显示成 0%） */
  rate: number | null;
  /** 有任务的天数 */
  daysWithTasks: number;
  /** 区间总天数 */
  days: number;
  /** 有任务的天里平均每天几条 */
  perActiveDay: number | null;
  /** 一次都没安排过的天数 */
  emptyDays: number;
}

/**
 * 区间总览。
 *
 * `rate` 在 total=0 时返回 null 而不是 0 —— 「这周没安排任何事」与
 * 「安排了但一件没做」是完全不同的信号，界面必须能区分开。
 */
export function rangeStats(days: DayMap, from: string, to: string): RangeStats {
  const span = dateSpan(from, to);
  let total = 0;
  let done = 0;
  let daysWithTasks = 0;
  for (const date of span) {
    const list = tasksOn(days, date);
    if (list.length === 0) continue;
    daysWithTasks++;
    total += list.length;
    done += list.filter((t) => t.done).length;
  }
  return {
    total,
    done,
    rate: total > 0 ? done / total : null,
    daysWithTasks,
    days: span.length,
    perActiveDay: daysWithTasks > 0 ? total / daysWithTasks : null,
    emptyDays: span.length - daysWithTasks,
  };
}

export interface Bucket {
  /** 该桶的日期范围（含两端），供 tooltip 显示 */
  from: string;
  to: string;
  total: number;
  done: number;
  rate: number | null;
}

/**
 * 近 N 周趋势：按周分组（周一为一周起点，与日历视图一致），
 * 返回**从旧到新**的 N 个桶（最后一个桶包含 `endDate`）。
 */
export function weeklyTrend(days: DayMap, endDate: string, weeks: number): Bucket[] {
  if (weeks <= 0) return [];
  // 找到 endDate 所在周的周一
  const dow = (parseDate(endDate).getDay() + 6) % 7;
  const thisMonday = addDays(endDate, -dow);

  const buckets: Bucket[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const from = addDays(thisMonday, -7 * i);
    const to = addDays(from, 6);
    const s = rangeStats(days, from, to);
    buckets.push({ from, to, total: s.total, done: s.done, rate: s.rate });
  }
  return buckets;
}

export interface WeekdayStat {
  /** 0 = 周一 … 6 = 周日 */
  weekday: number;
  total: number;
  done: number;
  rate: number | null;
}

/**
 * 按星期几聚合（揭示「哪天最不产出」）。
 *
 * 星期来自**任务所属的日期**，而不是完成时间 —— 本应用只记录「这一天要做什么」，
 * 没有逐条完成时间戳，硬算完成时刻会是编造的。
 */
export function weekdayStats(days: DayMap, from: string, to: string): WeekdayStat[] {
  const acc: WeekdayStat[] = Array.from({ length: 7 }, (_, i) => ({
    weekday: i,
    total: 0,
    done: 0,
    rate: null,
  }));
  for (const date of dateSpan(from, to)) {
    const list = tasksOn(days, date);
    if (list.length === 0) continue;
    const wd = (parseDate(date).getDay() + 6) % 7;
    acc[wd].total += list.length;
    acc[wd].done += list.filter((t) => t.done).length;
  }
  for (const a of acc) a.rate = a.total > 0 ? a.done / a.total : null;
  return acc;
}

export interface Coverage {
  scheduled: number;
  unscheduled: number;
  /** 设了时间范围的比例 0–1；无任务时为 null */
  rate: number | null;
  /** 未定时任务的标题（最多取前若干条，供界面举例） */
  samples: string[];
}

/**
 * 时间安排覆盖率：多少任务设了时间范围。
 *
 * 这条对「日内计划器」特别有意义 —— 计划的价值一半在「排进具体时段」，
 * 全是未定时任务说明它退化成了一个待办清单。
 */
export function schedulingCoverage(days: DayMap, from: string, to: string, sampleMax = 3): Coverage {
  let scheduled = 0;
  let unscheduled = 0;
  const samples: string[] = [];
  for (const date of dateSpan(from, to)) {
    for (const task of tasksOn(days, date)) {
      if (hasRange(task)) scheduled++;
      else {
        unscheduled++;
        if (samples.length < sampleMax) samples.push(task.title);
      }
    }
  }
  const total = scheduled + unscheduled;
  return { scheduled, unscheduled, rate: total > 0 ? scheduled / total : null, samples };
}

export interface StatusBreakdown {
  todo: number;
  doing: number;
  done: number;
}

/**
 * 某一天的状态分布。
 *
 * 用 `statusOf` 推导（而非直接看 `done`）—— 这样「进行中」是按时钟算出来的，
 * 与大纲/看板/时间轴显示的状态完全一致，不会出现统计页说「没有进行中」
 * 而大纲里亮着一条的情况。
 */
export function statusBreakdown(days: DayMap, date: string, now: Date = new Date()): StatusBreakdown {
  const out: StatusBreakdown = { todo: 0, doing: 0, done: 0 };
  for (const task of tasksOn(days, date)) out[statusOf(task, date, now)]++;
  return out;
}

/** 一天都没落下的连续完成天数（从 `endDate` 往前数；无任务的日子跳过不计） */
export function completionStreak(days: DayMap, endDate: string, lookback = 90): number {
  let streak = 0;
  let cur = endDate;
  for (let i = 0; i < lookback; i++) {
    const list = tasksOn(days, cur);
    if (list.length > 0) {
      if (list.every((t) => t.done)) streak++;
      else break;
    }
    // 无任务的日子既不计数也不中断（休息日不该把连续记录打断）
    cur = addDays(cur, -1);
  }
  return streak;
}
