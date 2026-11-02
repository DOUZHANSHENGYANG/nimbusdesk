import type { ProjectData, Iteration, WorkItem } from "./types";
import { validateZenProjectData } from "./zentao-core";

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}
export function shiftDate(value: string, days: number): string {
  if (!validDate(value)) throw new Error("Invalid date");
  const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function iterationRange(date: string, weeks: number): { start: string; end: string } {
  if (!validDate(date) || ![2, 3].includes(weeks)) throw new Error("Invalid iteration range");
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const start = shiftDate(date, -((day + 6) % 7));
  return { start, end: shiftDate(start, weeks * 7 - 3) };
}
export function resolvePlanWorkItem(tasks: readonly { id: string; parentId?: string | null; workItemId?: string | null }[], planId: string): string | null {
  const seen = new Set<string>(); const byId = new Map(tasks.map(t => [t.id, t]));
  let current = byId.get(planId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.workItemId !== undefined) return current.workItemId;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return null;
}
export function carryItem(data: ProjectData, id: string, target: string | null, now = Date.now()): ProjectData {
  const item = data.items.find(i => i.id === id); if (!item) throw new Error("Task not found");
  if (target && !data.iterations.some(i => i.id === target)) throw new Error("Iteration not found");
  if (item.activeIterationId === target) return data;
  const memberships = data.memberships.map(m => m.itemId === id && m.iterationId === item.activeIterationId ? { ...m, leftAt: now, updatedAt: now, snapshot: { title: item.title, status: item.status, deadline: item.deadline } } : m);
  if (target) {
    const existing = memberships.find(m => m.itemId === id && m.iterationId === target);
    if (existing) { const at = memberships.indexOf(existing); memberships[at] = { ...existing, leftAt: null, updatedAt: now }; }
    else memberships.push({ id: crypto.randomUUID(), itemId: id, iterationId: target, joinedAt: now, leftAt: null, carriedFrom: item.activeIterationId, updatedAt: now });
  }
  return { ...data, memberships, items: data.items.map(i => i.id === id ? { ...i, activeIterationId: target, updatedAt: now } : i) };
}
export function itemDeadline(item: WorkItem, iterations: Iteration[]): string | null {
  return item.deadline || iterations.find(i => i.id === item.activeIterationId)?.end || null;
}

/**
 * 侧栏与各处列表共用的显示顺序：置顶的在前，其余保持数组顺序（即用户拖出来的顺序）。
 * 纯函数，方便直接断言「置顶只影响分组、不重排组内」。
 */
export function orderedProjects<T extends { pinned?: boolean }>(projects: T[]): T[] {
  return [...projects.filter((project) => project.pinned), ...projects.filter((project) => !project.pinned)];
}

/** 页签只有在「有对应面板」时才算当前页：文件与图表挂在项目上，没选项目就退回任务列表。 */export type WorkTabKey = "overview" | "tasks" | "board" | "files" | "charts";
export function resolveActiveTab(tab: WorkTabKey, hasProject: boolean): WorkTabKey {
  if (tab === "overview" || tab === "board") return tab;
  if ((tab === "files" || tab === "charts") && hasProject) return tab;
  return "tasks";
}

/** 进度计算只依赖这几项，够用就好：项目级调用方不必构造完整 WorkItem。 */
export type ProgressNode = { id: string; parentId?: string | null; status: string; percent?: number | null; weight?: number };
export type ProgressItem = ProgressNode & { projectId: string | null };

function weightOf(item: { weight?: number }): number {
  return typeof item.weight === "number" && Number.isFinite(item.weight) && item.weight > 0 ? item.weight : 1;
}
/** 一条计划自身的完成度：人工百分比优先，否则按状态（done 即 100）。 */
export function itemPercent(item: Pick<ProgressNode, "status" | "percent">): number {
  if (typeof item.percent === "number" && Number.isFinite(item.percent)) return Math.max(0, Math.min(100, Math.round(item.percent)));
  return item.status === "done" ? 100 : 0;
}
/**
 * 计划树进度：叶子用自己的完成度，父计划按子计划的权重加权；取消的子计划不进分母。
 * 权重只在同层有意义，所以逐层归一化——把 ×3 的计划和它的 ×1 子计划放在同一个分母里算没有意义。
 */
export function planPercent(items: readonly ProgressNode[], id: string): number {
  const byId = new Map(items.map(item => [item.id, item]));
  const children = (parentId: string) => items.filter(item => item.parentId === parentId && item.status !== "cancelled");
  const walk = (node: ProgressNode, seen: Set<string>): number => {
    if (seen.has(node.id)) return itemPercent(node);
    seen.add(node.id);
    const kids = children(node.id);
    if (!kids.length) return itemPercent(node);
    let sum = 0, weight = 0;
    for (const kid of kids) { const w = weightOf(kid); sum += walk(kid, seen) * w; weight += w; }
    return weight ? Math.round(sum / weight) : 0;
  };
  const node = byId.get(id);
  return node ? walk(node, new Set()) : 0;
}
export function validateProjectData(data: ProjectData): void {
  if (!data || [data.projects, data.iterations, data.items, data.memberships].some(v => !Array.isArray(v))) throw new Error("Invalid project data arrays");
  const epoch = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
  const metadata = (values: { createdAt: number; updatedAt: number }[]) => { for (const v of values) if (!epoch(v.createdAt) || !epoch(v.updatedAt)) throw new Error("Invalid modification timestamp"); };
  metadata([...data.projects, ...data.iterations, ...data.items]);
  const ids = (values: { id: string }[], kind: string) => {
    const set = new Set<string>();
    for (const v of values) { if (!v || typeof v.id !== "string" || !v.id.trim() || set.has(v.id)) throw new Error(`Invalid ${kind} id`); set.add(v.id); }
    return set;
  };
  const projects = ids(data.projects, "project"), iterations = ids(data.iterations, "iteration"), items = ids(data.items, "item");
  const pair = new Set<string>(); ids(data.memberships, "membership");
  for (const p of data.projects) {
    if (typeof p.name !== "string" || !p.name.trim() || typeof p.note !== "string" || !["active", "archived"].includes(p.status) || (p.folder != null && (typeof p.folder !== "string" || !p.folder.trim()))) throw new Error("Invalid project");
    if (p.icon != null && (typeof p.icon !== "string" || !p.icon.trim() || p.icon.length > 60)) throw new Error("Invalid project icon");
    if (p.color != null && (!Number.isInteger(p.color) || p.color < 1 || p.color > 5)) throw new Error("Invalid project color");
    if (p.tags != null && (!Array.isArray(p.tags) || p.tags.length > 12 || p.tags.some(tag => typeof tag !== "string" || !tag.trim()) || new Set(p.tags.map(tag => tag.trim())).size !== p.tags.length)) throw new Error("Invalid project tags");
    if (p.pinned != null && typeof p.pinned !== "boolean") throw new Error("Invalid project pinned");
    if ((p.startDate != null && !validDate(p.startDate)) || (p.endDate != null && !validDate(p.endDate))) throw new Error("Invalid project dates");
    if (p.startDate && p.endDate && p.startDate > p.endDate) throw new Error("Invalid project dates");
  }
  for (const i of data.iterations) if (typeof i.name !== "string" || !i.name.trim() || !validDate(i.start) || !validDate(i.end) || i.start > i.end) throw new Error("Invalid iteration dates");
  for (const m of data.memberships) {
    const key = JSON.stringify([m.itemId, m.iterationId]);
    if (!items.has(m.itemId) || !iterations.has(m.iterationId) || pair.has(key) || !epoch(m.joinedAt) || !epoch(m.updatedAt) || (m.leftAt != null && (!epoch(m.leftAt) || m.leftAt < m.joinedAt)) || (m.carriedFrom != null && !iterations.has(m.carriedFrom))) throw new Error("Invalid iteration membership");
    pair.add(key);
  }
  for (const i of data.items) {
    if (typeof i.title !== "string" || !i.title.trim() || typeof i.note !== "string" || !["todo", "doing", "done", "cancelled"].includes(i.status) || (i.projectId != null && !projects.has(i.projectId)) || (i.deadline != null && !validDate(i.deadline))) throw new Error("Invalid task");
    if (i.activeIterationId && !data.memberships.some(m => m.itemId === i.id && m.iterationId === i.activeIterationId && m.leftAt == null)) throw new Error("Active iteration must have a live membership");
    if (data.memberships.some(m => m.itemId === i.id && m.leftAt == null && m.iterationId !== i.activeIterationId)) throw new Error("A task can have only one current iteration");
    if (i.weight != null && !(Number.isFinite(i.weight) && i.weight > 0 && i.weight <= 1000)) throw new Error("Invalid task weight");
    if (i.percent != null && !(Number.isInteger(i.percent) && i.percent >= 0 && i.percent <= 100)) throw new Error("Invalid task percent");
    if ((i.startDate != null && !validDate(i.startDate)) || (i.endDate != null && !validDate(i.endDate))) throw new Error("Invalid task dates");
    if (i.startDate && i.endDate && i.startDate > i.endDate) throw new Error("Invalid task dates");
    if (i.parentId != null && !items.has(i.parentId)) throw new Error("Invalid task parent");
  }
  // 子计划：不能指向自己、不能跨项目、不能成环。校验放在最后，前面已经保证 parent 存在。
  for (const i of data.items) {
    if (i.parentId == null) continue;
    if (i.parentId === i.id) throw new Error("A task cannot be its own parent");
    let cursor: WorkItem | undefined = data.items.find(value => value.id === i.parentId);
    if ((cursor?.projectId ?? null) !== (i.projectId ?? null)) throw new Error("Subtasks must share the project");
    let guard = 0;
    while (cursor?.parentId && guard++ <= data.items.length) {
      if (cursor.parentId === i.id) throw new Error("Task hierarchy cannot cycle");
      cursor = data.items.find(value => value.id === cursor!.parentId);
    }
  }
  for (const snapshot of data.snapshots ?? []) {
    if (!validDate(snapshot.date) || typeof snapshot.projectId !== "string" || !snapshot.projectId.trim()) throw new Error("Invalid progress snapshot");
    for (const key of ["todo", "doing", "done", "cancelled"] as const) if (!Number.isInteger(snapshot[key]) || snapshot[key] < 0) throw new Error("Invalid progress snapshot");
    for (const key of ["points", "donePoints"] as const) if (!Number.isFinite(snapshot[key]) || snapshot[key] < 0) throw new Error("Invalid progress snapshot");
  }
  validateZenProjectData(data);
}

/** 项目进度：人工覆盖 > 计划权重聚合 > 计划时间推算。 */
export function projectProgress(
  project: { id: string; startDate?: string | null; endDate?: string | null; progressManual?: number | null },
  items: readonly ProgressItem[],
  today: string,
): { value: number; source: "manual" | "time" | "items" } {
  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
  if (typeof project.progressManual === "number" && Number.isFinite(project.progressManual)) {
    return { value: clamp(project.progressManual), source: "manual" };
  }
  if (project.startDate && project.endDate) {
    const start = Date.parse(project.startDate), end = Date.parse(project.endDate), now = Date.parse(today);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return { value: clamp(((now - start) / (end - start)) * 100), source: "time" };
    }
  }
  // 只算顶层计划，子计划已经并进父计划；取消的不进分母。全为默认权重时等价于按条数算。
  const own = items.filter(item => item.projectId === project.id && item.status !== "cancelled");
  const roots = own.filter(item => !item.parentId || !own.some(other => other.id === item.parentId));
  if (!roots.length) return { value: 0, source: "items" };
  let sum = 0, weight = 0;
  for (const root of roots) { const w = weightOf(root); sum += planPercent(own, root.id) * w; weight += w; }
  return { value: weight ? clamp(sum / weight) : 0, source: "items" };
}
