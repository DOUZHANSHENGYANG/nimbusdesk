import type { ProjectData, ReminderRule, Iteration, WorkItem, ReminderDelivery } from "./types";
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
export function validateReminderRule(rule: ReminderRule): ReminderRule {
  if (!rule || typeof rule.enabled !== "boolean" || !Array.isArray(rule.times) || !rule.times.length || rule.times.length > 12 || rule.times.some(t => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) || !Number.isInteger(rule.advanceDays) || rule.advanceDays < 0 || rule.advanceDays > 365 || !Array.isArray(rule.weekdays) || !rule.weekdays.length || rule.weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6) || !["same", "previous"].includes(rule.nonWorkingDay)) throw new Error("Invalid reminder rule");
  new Intl.DateTimeFormat("en", { timeZone: rule.timezone }).format();
  return { ...rule, times: [...new Set(rule.times)].sort(), weekdays: [...new Set(rule.weekdays)].sort() };
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
function wallClock(now: Date, timezone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (name: string) => parts.find(p => p.type === name)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}
export interface DueProjectReminder extends Omit<ReminderDelivery, "notifiedAt"> { title: string; deadline: string }
export function dueProjectReminders(data: ProjectData, now: Date): DueProjectReminder[] {
  const result: DueProjectReminder[] = [];
  for (const item of data.items) {
    if (item.status === "done" || item.status === "cancelled") continue;
    const project = data.projects.find(p => p.id === item.projectId);
    if (project?.status === "archived") continue;
    const rule = validateReminderRule(item.reminder ?? project?.reminder ?? data.reminderRule);
    if (!rule.enabled) continue;
    const deadline = itemDeadline(item, data.iterations); if (!deadline || !validDate(deadline)) continue;
    let scheduled = shiftDate(deadline, -rule.advanceDays);
    if (rule.nonWorkingDay === "previous") {
      while (!rule.weekdays.includes(new Date(`${scheduled}T12:00:00Z`).getUTCDay())) scheduled = shiftDate(scheduled, -1);
    } else if (!rule.weekdays.includes(new Date(`${scheduled}T12:00:00Z`).getUTCDay())) continue;
    const clock = wallClock(now, rule.timezone); if (clock.date !== scheduled) continue;
    // Stable per-effective-date/slot keys: editing unrelated settings never replays a sent reminder.
    const prefix = `${item.id}|${deadline}|${scheduled}|`;
    const sent = new Set(data.deliveries.filter(d => d.itemId === item.id && d.date === scheduled && d.id.startsWith(prefix)).flatMap(d => d.slots));
    const slots = rule.times.filter(t => t <= clock.time && !sent.has(t));
    if (slots.length) result.push({ id: `${prefix}${slots.join(",")}`, itemId: item.id, date: scheduled, slots, title: item.title, deadline });
  }
  return result;
}

export function validateProjectData(data: ProjectData): void {
  if (!data || [data.areas, data.projects, data.iterations, data.items, data.memberships, data.deliveries].some(v => !Array.isArray(v))) throw new Error("Invalid project data arrays");
  const epoch = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
  const metadata = (values: { createdAt: number; updatedAt: number }[]) => { for (const v of values) if (!epoch(v.createdAt) || !epoch(v.updatedAt)) throw new Error("Invalid modification timestamp"); };
  metadata([...data.areas, ...data.projects, ...data.iterations, ...data.items]);
  const ids = (values: { id: string }[], kind: string) => {
    const set = new Set<string>();
    for (const v of values) { if (!v || typeof v.id !== "string" || !v.id.trim() || set.has(v.id)) throw new Error(`Invalid ${kind} id`); set.add(v.id); }
    return set;
  };
  const areas = ids(data.areas, "area"), projects = ids(data.projects, "project"), iterations = ids(data.iterations, "iteration"), items = ids(data.items, "item");
  const pair = new Set<string>(); ids(data.memberships, "membership");
  validateReminderRule(data.reminderRule);
  for (const a of data.areas) if (typeof a.name !== "string" || !a.name.trim()) throw new Error("Invalid business area");
  for (const p of data.projects) {
    if (typeof p.name !== "string" || !p.name.trim() || typeof p.note !== "string" || !["active", "archived"].includes(p.status) || (p.folder != null && (typeof p.folder !== "string" || !p.folder.trim())) || (p.areaId != null && !areas.has(p.areaId))) throw new Error("Invalid project");
    if (p.reminder) validateReminderRule(p.reminder);
  }
  for (const i of data.iterations) if (typeof i.name !== "string" || !i.name.trim() || !validDate(i.start) || !validDate(i.end) || i.start > i.end) throw new Error("Invalid iteration dates");
  for (const m of data.memberships) {
    const key = JSON.stringify([m.itemId, m.iterationId]);
    if (!items.has(m.itemId) || !iterations.has(m.iterationId) || pair.has(key) || !epoch(m.joinedAt) || !epoch(m.updatedAt) || (m.leftAt != null && (!epoch(m.leftAt) || m.leftAt < m.joinedAt)) || (m.carriedFrom != null && !iterations.has(m.carriedFrom))) throw new Error("Invalid iteration membership");
    pair.add(key);
  }
  for (const i of data.items) {
    if (typeof i.title !== "string" || !i.title.trim() || typeof i.note !== "string" || !["todo", "doing", "done", "cancelled"].includes(i.status) || (i.projectId != null && !projects.has(i.projectId)) || (i.areaId != null && !areas.has(i.areaId)) || (i.deadline != null && !validDate(i.deadline))) throw new Error("Invalid task");
    if (i.activeIterationId && !data.memberships.some(m => m.itemId === i.id && m.iterationId === i.activeIterationId && m.leftAt == null)) throw new Error("Active iteration must have a live membership");
    if (data.memberships.some(m => m.itemId === i.id && m.leftAt == null && m.iterationId !== i.activeIterationId)) throw new Error("A task can have only one current iteration");
    if (i.reminder) validateReminderRule(i.reminder);
  }
  ids(data.deliveries, "delivery");
  for (const d of data.deliveries) if (!items.has(d.itemId) || !validDate(d.date) || !epoch(d.notifiedAt) || !Array.isArray(d.slots) || !d.slots.length || d.slots.some(s => typeof s !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s))) throw new Error("Invalid reminder delivery");
  validateZenProjectData(data);
}
