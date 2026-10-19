import type { ProjectData, WorkItem } from "./types";
import type { PlanTask, ArchivedDay } from "../plans/types";
import type { ZenConnectionData, ZenFields, ZenFetchResult } from "./zentao-types";
import { mergeZenFields, remoteFields, validZenFields as validFields, zenBounded as bounded, zenDate as date, zenEpoch as epoch, zenTimestamp as timestamp, ZEN_WRITE_FIELDS } from "./zentao-fields";
import { validateZenChanges } from "./zentao-writeback-core";
export { remoteFields } from "./zentao-fields";

const keys = ["title", "note", "deadline", "status"] as const;
const positive = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
const text = (v: unknown) => typeof v === "string";
function assert(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(reason); }
export function normalizeZenUrl(input: string): string {
  const url = new URL(input);
  assert(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, "Use an HTTP(S) instance URL without credentials or query parameters");
  url.pathname = url.pathname.replace(/\/(?:api\.php(?:\/v[12])?|api\/v[12])\/?$/i, "/").replace(/\/*$/, "/");
  return url.toString();
}
export function validateZenConnections(data: ZenConnectionData): void {
  assert(data && Array.isArray(data.connections) && data.syncStates && typeof data.syncStates === "object" && !Array.isArray(data.syncStates), "Invalid connection data");
  assert(Object.keys(data).every(k => ["connections", "syncStates"].includes(k)) && data.connections.length <= 100, "Invalid connection metadata fields");
  const ids = new Set<string>();
  for (const c of data.connections) {
    assert(c && text(c.id) && /^[a-zA-Z0-9_-]{1,80}$/.test(c.id) && !ids.has(c.id), "Invalid connection identity"); ids.add(c.id);
    assert(Object.keys(c).every(k => ["id", "name", "baseUrl", "account", "apiVersion", "executionIds", "autoSync", "syncMinutes", "createdAt", "updatedAt", "writeFields"].includes(k)), "Credentials must stay in the Windows credential manager");
    if (c.writeFields !== undefined) assert(Array.isArray(c.writeFields) && c.writeFields.length <= 3 && new Set(c.writeFields).size === c.writeFields.length && c.writeFields.every(k => ZEN_WRITE_FIELDS.includes(k)), "Invalid writable fields");
    assert(bounded(c.name, 1000, false) && c.name.length <= 300 && bounded(c.baseUrl, 2048) && bounded(c.account, 256) && !/[\r\n]/.test(c.account) && epoch(c.createdAt) && epoch(c.updatedAt), "Invalid connection metadata");
    if (c.baseUrl) normalizeZenUrl(c.baseUrl);
    assert(["auto", "v1", "v2"].includes(c.apiVersion) && Array.isArray(c.executionIds) && c.executionIds.length <= 100 && c.executionIds.every(positive) && new Set(c.executionIds).size === c.executionIds.length && typeof c.autoSync === "boolean" && positive(c.syncMinutes) && c.syncMinutes <= 1440, "Invalid synchronization settings");
  }
  for (const [id, m] of Object.entries(data.syncStates)) {
    assert(ids.has(id) && m && (m.lastSyncAt === null || epoch(m.lastSyncAt)) && (m.lastError === null || bounded(m.lastError, 2000)) && epoch(m.lastCount) && m.lastCount <= 100_000 && [null, "v1", "v2"].includes(m.resolvedVersion) && typeof m.authRequired === "boolean", "Invalid sync status");
    assert(Object.keys(m).every(k => ["lastSyncAt", "lastError", "lastCount", "resolvedVersion", "authRequired"].includes(k)), "Invalid sync metadata fields");
  }
}
export function validateZenProjectData(data: ProjectData): void {
  const tasks = data.remoteTasks ?? [], executions = data.remoteExecutions ?? [], links = data.remoteLinks ?? [];
  assert([tasks, executions, links].every(Array.isArray), "Invalid remote cache arrays");
  assert(tasks.length <= 100_000 && executions.length <= 10_000 && links.length <= 100_000, "Remote cache limit exceeded");
  const taskIds = new Set<string>(), executionIds = new Set<string>(), itemIds = new Set<string>(), sourceIds = new Set<string>();
  for (const t of tasks) {
    assert(t && bounded(t.connectionId, 200, false) && positive(t.remoteId) && t.id === `${t.connectionId}:task:${t.remoteId}` && !taskIds.has(t.id), "Invalid remote task identity"); taskIds.add(t.id);
    assert(bounded(t.title, 10_000, false) && bounded(t.note, 1_000_000) && bounded(t.status, 100, false) && date(t.deadline) && date(t.start) && [t.remoteProjectId, t.executionId, t.parentRemoteId].every(v => v === null || positive(v)) && bounded(t.assignedTo, 1000) && Array.isArray(t.teamAccounts) && t.teamAccounts.length <= 1000 && t.teamAccounts.every(v => bounded(v, 1000, false)) && timestamp(t.lastEditedDate) && epoch(t.updatedAt), "Invalid remote task cache");
  }
  for (const e of executions) {
    assert(e && bounded(e.connectionId, 200, false) && positive(e.remoteId) && e.id === `${e.connectionId}:execution:${e.remoteId}` && !executionIds.has(e.id) && bounded(e.name, 10_000, false) && date(e.start) && date(e.end) && (e.start === null || e.end === null || e.start <= e.end) && bounded(e.status, 100, false) && epoch(e.updatedAt), "Invalid remote execution cache"); executionIds.add(e.id);
  }
  for (const l of links) {
    const item = data.items.find(i => i.id === l.itemId);
    assert(l && taskIds.has(l.id) && l.id === `${l.connectionId}:task:${l.remoteId}` && positive(l.remoteId) && !sourceIds.has(l.id) && item && !item.mergedIntoId && !itemIds.has(l.itemId) && validFields(l.baseline) && epoch(l.updatedAt) && Array.isArray(l.divergedFields) && l.divergedFields.every(k => keys.includes(k as typeof keys[number])), "Invalid remote task link"); sourceIds.add(l.id); itemIds.add(l.itemId);
  }
  for (const item of data.items) if (item.mergedIntoId != null) {
    const target = data.items.find(i => i.id === item.mergedIntoId);
    assert(target && target.id !== item.id && !target.mergedIntoId && item.status === "cancelled", "Invalid merged task target");
  }
  validateZenChanges(data);
}
export function applyZenSnapshot(data: ProjectData, connectionId: string, result: ZenFetchResult, now = Date.now()): { data: ProjectData; added: number; updated: number } {
  const next = structuredClone(data); next.remoteTasks ??= []; next.remoteLinks ??= []; next.remoteExecutions ??= [];
  let added = 0, updated = 0;
  const incoming = new Map(result.tasks.map(t => [t.id, t]));
  for (const task of incoming.values()) {
    assert(task.connectionId === connectionId, "Unexpected task connection");
    const cached = next.remoteTasks.findIndex(t => t.id === task.id);
    if (cached < 0) next.remoteTasks.push(task); else next.remoteTasks[cached] = task;
    const fields = remoteFields(task), link = next.remoteLinks.find(l => l.id === task.id);
    if (!link) {
      const id = crypto.randomUUID();
      next.items.push({ id, createdAt: now, updatedAt: now, ...fields, areaId: null, projectId: null, activeIterationId: null });
      next.remoteLinks.push({ id: task.id, connectionId, remoteId: task.remoteId, itemId: id, baseline: fields, divergedFields: [], updatedAt: now }); added++;
    } else {
      const item = next.items.find(i => i.id === link.itemId); assert(item && !item.mergedIntoId, "Missing bound task");
      const { baseline, patch, divergedFields } = mergeZenFields(item, link.baseline, fields);
      if (Object.entries(patch).some(([k, v]) => item[k as keyof WorkItem] !== v)) { Object.assign(item, patch, { updatedAt: now }); updated++; }
      Object.assign(link, { baseline, divergedFields, updatedAt: now });
    }
  }
  for (const e of result.executions) {
    assert(e.connectionId === connectionId, "Unexpected execution connection");
    const at = next.remoteExecutions.findIndex(v => v.id === e.id); if (at < 0) next.remoteExecutions.push(e); else next.remoteExecutions[at] = e;
  }
  validateZenProjectData(next); return { data: next, added, updated };
}
export function buildZenBinding(data: ProjectData, plans: Record<string, PlanTask[]>, archive: Record<string, ArchivedDay>, itemId: string, remoteTaskId: string, choices: Partial<Record<keyof ZenFields, "local" | "remote">> = {}, now = Date.now()) {
  const next = structuredClone(data); next.remoteLinks ??= [];
  const item = next.items.find(i => i.id === itemId), task = next.remoteTasks?.find(t => t.id === remoteTaskId);
  assert(item && !item.mergedIntoId && task, "Task unavailable");
  assert(!next.remoteLinks.some(l => l.itemId === itemId), "Task is already bound");
  assert(Object.keys(choices).every(k => keys.includes(k as typeof keys[number]) && ["local", "remote"].includes(choices[k as keyof ZenFields]!)), "Invalid field selection");
  const source = next.remoteLinks.find(l => l.id === remoteTaskId), donor = next.items.find(i => i.id === source?.itemId);
  const previousChange = next.remoteChanges?.find(q => q.id === remoteTaskId);
  assert(!previousChange || !["sending", "uncertain"].includes(previousChange.status), "Verify the previous write result before merging this source");
  const fields = remoteFields(task);
  for (const key of keys) if (choices[key] === "remote") Object.assign(item, { [key]: fields[key] });
  item.updatedAt = now;
  if (donor) {
    assert(!next.items.some(i => i.mergedIntoId === donor.id), "Resolve earlier merges before merging this task");
    const original = structuredClone(donor); delete original.mergedSnapshot;
    donor.mergedSnapshot = { item: original, source: structuredClone(source!), ...(previousChange ? { change: structuredClone(previousChange) } : {}), mergedAt: now };
    donor.mergedIntoId = itemId; donor.status = "cancelled"; donor.updatedAt = now;
    // Keep the donor and its original memberships as an audit trail. Add closed
    // copies of periods missing from the survivor; its chosen current period wins.
    for (const m of [...next.memberships].filter(m => m.itemId === donor.id)) {
      if (!next.memberships.some(v => v.itemId === itemId && v.iterationId === m.iterationId)) next.memberships.push({ ...m, id: crypto.randomUUID(), itemId, leftAt: m.leftAt ?? now, snapshot: m.snapshot ?? { title: original.title, status: original.status, deadline: original.deadline }, updatedAt: now });
    }
  }
  next.remoteLinks = next.remoteLinks.filter(l => l.id !== remoteTaskId);
  next.remoteLinks.push({ id: task.id, connectionId: task.connectionId, remoteId: task.remoteId, itemId, baseline: fields, divergedFields: [], updatedAt: now });
  next.remoteChanges = (next.remoteChanges ?? []).filter(q => q.id !== remoteTaskId);
  const redirect = (tasks: PlanTask[]) => tasks.map(p => donor && p.workItemId === donor.id ? { ...p, workItemId: itemId, updatedAt: now } : p);
  const nextPlans = Object.fromEntries(Object.entries(plans).map(([d, tasks]) => [d, redirect(tasks)]));
  const nextArchive = Object.fromEntries(Object.entries(archive).map(([d, day]) => [d, { ...day, tasks: redirect(day.tasks) }]));
  validateZenProjectData(next); return { data: next, plans: nextPlans, archive: nextArchive };
}
