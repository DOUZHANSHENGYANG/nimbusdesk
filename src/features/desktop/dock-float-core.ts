/** 胶囊 Dock 的纯计算：日期格、今日进度、相对时间。全部无副作用，便于单测。 */
import type { PlanTask } from "@/features/plans/types";

const pad = (n: number) => String(n).padStart(2, "0");

/** 本地日期键 YYYY-MM-DD（与 plans 的 date 同口径）。 */
export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface DayCell {
  /** YYYY-MM-DD */
  date: string;
  day: number;
  inMonth: boolean;
}

/**
 * 月视图的 42 格（周一起始，6 行）。
 *
 * 固定 42 格而不是「按需 5/6 行」：卡片高度必须恒定，切月份时少一行会让
 * 窗口跟着跳 —— 悬停展开的形态最怕这个。
 */
export function monthGrid(year: number, month: number): DayCell[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - offset);
  const cells: DayCell[] = [];
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    cells.push({ date: dateKey(date), day: date.getDate(), inMonth: date.getMonth() === month });
  }
  return cells;
}

export interface DaySummary {
  /** 顶层任务数（子任务不单独计） */
  total: number;
  todo: number;
  done: number;
  /** 有时间、已过点、还没完成的顶层任务 */
  late: number;
  percent: number;
}

/** 今日进度：只数顶层任务，子任务交给父任务上的 2/3 角标。 */
export function summarizeDay(tasks: readonly PlanTask[], now: Date = new Date()): DaySummary {
  const tops = tasks.filter((task) => !task.parentId);
  const total = tops.length;
  const done = tops.filter((task) => task.done).length;
  const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const late = tops.filter((task) => !task.done && task.start && task.start < clock).length;
  return { total, todo: total - done, done, late, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

export interface AgeBucket {
  unit: "minute" | "hour" | "day";
  value: number;
}

/**
 * 资讯的相对时间。返回值只带单位与数量，文案交给 i18n —— 这样中英文都不用在
 * 这里拼字符串，也不会因为语言切换留下旧值。
 */
export function ageBucket(stamp: number | undefined, now: number = Date.now()): AgeBucket | null {
  if (!stamp || !Number.isFinite(stamp)) return null;
  const minutes = Math.floor(Math.max(0, now - stamp) / 60000);
  if (minutes < 60) return { unit: "minute", value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hour", value: hours };
  return { unit: "day", value: Math.floor(hours / 24) };
}

/** 子任务进度（"2/3"）；没有子任务返回 null。 */
export function childProgress(tasks: readonly PlanTask[], parentId: string): { done: number; total: number } | null {
  const kids = tasks.filter((task) => task.parentId === parentId);
  if (kids.length === 0) return null;
  return { done: kids.filter((task) => task.done).length, total: kids.length };
}
