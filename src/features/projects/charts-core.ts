/** 图表只用这几个纯函数算数据，组件里不写业务规则；这样四张图都能单测。 */
import type { Iteration, ProgressSnapshot, WorkItem } from "./types";
import { itemPercent } from "./core";

const DAY = 86_400_000;

export function rangeDays(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = Date.parse(`${from}T12:00:00Z`);
  const end = Date.parse(`${to}T12:00:00Z`);
  if (!Number.isFinite(cursor) || !Number.isFinite(end)) return out;
  while (cursor <= end && out.length < 400) { out.push(new Date(cursor).toISOString().slice(0, 10)); cursor += DAY; }
  return out;
}

/** 当天这一屏的计数与点数：点数就是同层权重，完成度按 itemPercent 折算。 */
export function snapshotOf(projectId: string, items: readonly WorkItem[], date: string): ProgressSnapshot {
  let todo = 0, doing = 0, done = 0, cancelled = 0, points = 0, donePoints = 0;
  for (const item of items) {
    if (item.projectId !== projectId) continue;
    if (item.status === "cancelled") { cancelled++; continue; }
    if (item.status === "done") done++; else if (item.status === "doing") doing++; else todo++;
    const weight = typeof item.weight === "number" && item.weight > 0 ? item.weight : 1;
    points += weight;
    donePoints += (itemPercent(item) / 100) * weight;
  }
  return { date, projectId, todo, doing, done, cancelled, points: Math.round(points * 10) / 10, donePoints: Math.round(donePoints * 10) / 10 };
}

/** 同一天同项目只留一行；超出一年的老快照丢掉，别让状态文件无限长。 */
export function upsertSnapshot(list: readonly ProgressSnapshot[], next: ProgressSnapshot): ProgressSnapshot[] {
  const kept = list.filter(entry => !(entry.date === next.date && entry.projectId === next.projectId));
  const cutoff = new Date(Date.parse(`${next.date}T12:00:00Z`) - 365 * DAY).toISOString().slice(0, 10);
  return [...kept.filter(entry => entry.date >= cutoff), next].sort((a, b) => a.date.localeCompare(b.date) || a.projectId.localeCompare(b.projectId));
}

/** 当天没有快照就沿用之前最近的一天：中间没打开应用，不该在图上画成 0。 */
function at(list: readonly ProgressSnapshot[], projectId: string, date: string): ProgressSnapshot | null {
  let found: ProgressSnapshot | null = null;
  for (const entry of list) if (entry.projectId === projectId && entry.date <= date) found = entry;
  return found;
}

export interface BurndownPoint { date: string; remaining: number; ideal: number }
export function burndown(list: readonly ProgressSnapshot[], projectId: string, from: string, to: string): BurndownPoint[] {
  const days = rangeDays(from, to);
  const start = days.length ? at(list, projectId, days[0]) : null;
  const total = start?.points ?? 0;
  if (!total) return [];
  return days.map((date, index) => {
    const entry = at(list, projectId, date);
    return { date, remaining: Math.max(0, Math.round((entry ? entry.points - entry.donePoints : total) * 10) / 10), ideal: Math.round((total * (1 - index / Math.max(1, days.length - 1))) * 10) / 10 };
  });
}

export interface CfdPoint { date: string; todo: number; doing: number; done: number }
export function cfd(list: readonly ProgressSnapshot[], projectId: string, from: string, to: string): CfdPoint[] {
  return rangeDays(from, to).flatMap(date => {
    const entry = at(list, projectId, date);
    return entry ? [{ date, todo: entry.todo, doing: entry.doing, done: entry.done }] : [];
  });
}

export interface VelocityBar { id: string; name: string; donePoints: number }
/** 速率 = 迭代结束那天已完成的点数 − 迭代开始那天的已完成点数。 */
export function velocity(list: readonly ProgressSnapshot[], projectId: string, iterations: readonly Iteration[]): VelocityBar[] {
  return iterations
    .filter(iteration => iteration.start <= (list.at(-1)?.date ?? ""))
    .sort((a, b) => a.start.localeCompare(b.start))
    .map(iteration => {
      const before = at(list, projectId, shift(iteration.start, -1))?.donePoints ?? 0;
      const after = at(list, projectId, iteration.end)?.donePoints ?? before;
      return { id: iteration.id, name: iteration.name, donePoints: Math.max(0, Math.round((after - before) * 10) / 10) };
    })
    .filter(bar => bar.donePoints > 0);
}

function shift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

export interface GanttRow { id: string; title: string; depth: number; start: string; end: string; percent: number; tone: "done" | "doing" | "overdue" | "todo" }
/** 甘特只画有起止的计划：缺的一端用截止日、迭代区间或当天兜底，都没有就不画。 */
export function ganttRows(items: readonly WorkItem[], iterations: readonly Iteration[], today: string): GanttRow[] {
  const byId = new Map(items.map(item => [item.id, item]));
  const depthOf = (item: WorkItem) => { let level = 0, cursor = item.parentId ? byId.get(item.parentId) : undefined; while (cursor && level < 8) { level++; cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined; } return level; };
  return items.flatMap(item => {
    if (item.status === "cancelled") return [];
    const iteration = iterations.find(entry => entry.id === item.activeIterationId);
    const start = item.startDate ?? iteration?.start ?? item.deadline ?? null;
    const end = item.endDate ?? item.deadline ?? iteration?.end ?? start;
    if (!start || !end || start > end) return [];
    const closed = item.status === "done";
    const tone: GanttRow["tone"] = closed ? "done" : end < today ? "overdue" : item.status === "doing" ? "doing" : "todo";
    return [{ id: item.id, title: item.title, depth: depthOf(item), start, end, percent: itemPercent(item), tone }];
  });
}
