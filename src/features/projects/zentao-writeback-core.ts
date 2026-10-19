import type { ProjectData } from "./types";
import type { ZenChange, ZenConnection, ZenFields, ZenTask, ZenWriteField } from "./zentao-types";
import { mergeZenFields, remoteFields, validZenFields, zenBounded, zenEpoch, ZEN_FIELD_KEYS, ZEN_WRITE_FIELDS } from "./zentao-fields";

type Policy = Pick<ZenConnection, "id" | "writeFields">;
export type ZenSelections = Partial<Record<ZenWriteField, { choice: "local" | "remote" | "edit"; value?: string | null }>>;
function fail(message: string): never { throw new Error(message); }
const fieldsOf = (v: ZenFields): ZenFields => ({ title: v.title, note: v.note, deadline: v.deadline, status: v.status });
function sameFields(a: ZenFields, b: ZenFields) { return ZEN_FIELD_KEYS.every(key => a[key] === b[key]); }
export function validateZenChanges(data: ProjectData): void {
  const values = data.remoteChanges ?? [];
  if (!Array.isArray(values) || values.length > 100_000) fail("Invalid writeback queue");
  const seen = new Set<string>();
  for (const q of values) {
    const link = data.remoteLinks?.find(l => l.id === q?.id);
    if (!q || !link || seen.has(q.id) || link.connectionId !== q.connectionId || link.remoteId !== q.remoteId || link.itemId !== q.itemId || !["pending", "conflict", "sending", "uncertain", "failed"].includes(q.status) || !zenEpoch(q.updatedAt)) fail("Invalid writeback identity or status");
    seen.add(q.id);
    if (Object.keys(q).some(k => !["id", "connectionId", "remoteId", "itemId", "status", "base", "local", "remote", "expected", "fields", "lastError", "updatedAt"].includes(k))) fail("Unsupported writeback field");
    if (![q.base, q.local, q.remote, q.expected].every(validZenFields) || !Array.isArray(q.fields) || !q.fields.length || q.fields.length > 3 || new Set(q.fields).size !== q.fields.length || q.fields.some(k => !ZEN_WRITE_FIELDS.includes(k)) || (q.lastError !== null && !zenBounded(q.lastError, 2000))) fail("Invalid writeback fields");
  }
}
export function reconcileZenChanges(data: ProjectData, policies: readonly Policy[], now = Date.now()): ProjectData {
  const changes: ZenChange[] = [];
  for (const link of data.remoteLinks ?? []) {
    const previous = data.remoteChanges?.find(q => q.id === link.id);
    if (previous && ["sending", "uncertain"].includes(previous.status)) { changes.push(previous); continue; }
    const writable = policies.find(p => p.id === link.connectionId)?.writeFields ?? [];
    const item = data.items.find(i => i.id === link.itemId), task = data.remoteTasks?.find(t => t.id === link.id);
    if (!item || !task || item.mergedIntoId || !writable.length) continue;
    const local = fieldsOf(item), remote = remoteFields(task), base = { ...link.baseline };
    const fields = ZEN_WRITE_FIELDS.filter(k => writable.includes(k) && local[k] !== remote[k]);
    if (!fields.length) continue;
    const conflict = fields.some(k => local[k] !== base[k] && remote[k] !== base[k]);
    const status = conflict ? "conflict" : previous?.status === "failed" && sameFields(previous.local, local) && sameFields(previous.remote, remote) ? "failed" : "pending";
    const next: ZenChange = { id: link.id, connectionId: link.connectionId, remoteId: link.remoteId, itemId: link.itemId, status, base, local, remote, fields, expected: remote, lastError: status === "failed" ? previous!.lastError : null, updatedAt: Math.max(now, (previous?.updatedAt ?? 0) + 1) };
    const unchanged = previous && next.status === previous.status && next.lastError === previous.lastError && ["base", "local", "remote", "expected"].every(k => sameFields(next[k as "base"], previous[k as "base"])) && JSON.stringify(fields) === JSON.stringify(previous.fields);
    changes.push(unchanged ? previous : next);
  }
  return { ...data, remoteChanges: changes };
}
export function prepareZenWrite(data: ProjectData, id: string, policies: readonly Policy[], now = Date.now()) {
  const old = data.remoteChanges?.find(q => q.id === id);
  if (old && ["uncertain", "sending"].includes(old.status)) fail("Verify the previous write result before retrying");
  const next = reconcileZenChanges(data, policies, now), q = next.remoteChanges.find(v => v.id === id);
  if (!q) fail("No enabled local changes to send");
  if (q.status === "conflict") fail("Resolve conflicting fields before sending");
  const change: ZenChange = { ...q, status: "sending", expected: { ...q.remote }, lastError: null, updatedAt: Math.max(now, q.updatedAt + 1) };
  const changes = Object.fromEntries(change.fields.map(k => [k, change.local[k]])) as Partial<Pick<ZenFields, ZenWriteField>>;
  return { data: { ...next, remoteChanges: next.remoteChanges.map(v => v.id === id ? change : v) }, changes, expected: change.expected };
}
export function resolveZenChange(data: ProjectData, id: string, selections: ZenSelections, expectedUpdatedAt: number, policies: readonly Policy[], now = Date.now()): ProjectData {
  const current = reconcileZenChanges(data, policies, now), q = current.remoteChanges.find(v => v.id === id);
  if (!q || q.updatedAt !== expectedUpdatedAt) fail("Comparison changed; refresh the field choices");
  if (["sending", "uncertain"].includes(q.status)) fail("Verify the previous write result before resolving");
  if (Object.keys(selections).some(k => !q.fields.includes(k as ZenWriteField)) || q.fields.some(k => !selections[k])) fail("Choose a value for every changed field");
  const next = structuredClone(current), item = next.items.find(i => i.id === q.itemId)!, link = next.remoteLinks.find(l => l.id === id)!;
  for (const key of q.fields) {
    const selection = selections[key]!;
    if (!["local", "remote", "edit"].includes(selection.choice)) fail("Invalid field choice");
    const value = selection.choice === "remote" ? q.remote[key] : selection.choice === "local" ? item[key] : selection.value;
    Object.assign(item, { [key]: value }); Object.assign(link.baseline, { [key]: q.remote[key] });
  }
  if (!validZenFields(fieldsOf(item))) fail("Invalid selected task values");
  item.updatedAt = now; link.updatedAt = now; link.divergedFields = link.divergedFields.filter(k => !q.fields.includes(k as ZenWriteField));
  next.remoteChanges = next.remoteChanges.filter(v => v.id !== id);
  return reconcileZenChanges(next, policies, now);
}
function updateVerifiedRemote(data: ProjectData, id: string, task: ZenTask, acknowledge: boolean, policies: readonly Policy[], now: number): ProjectData {
  const next = structuredClone(data), q = next.remoteChanges?.find(v => v.id === id), link = next.remoteLinks.find(l => l.id === id);
  if (!link || task.id !== id || task.connectionId !== link.connectionId || task.remoteId !== link.remoteId) fail("Source identity changed");
  const item = next.items.find(i => i.id === link.itemId)!;
  const remote = remoteFields(task);
  if (acknowledge && q) for (const key of q.fields) Object.assign(link.baseline, { [key]: remote[key] });
  const merged = mergeZenFields(item, link.baseline, remote);
  Object.assign(item, merged.patch, { updatedAt: now }); Object.assign(link, { baseline: merged.baseline, divergedFields: merged.divergedFields, updatedAt: now });
  next.remoteTasks = next.remoteTasks.map(v => v.id === id ? task : v);
  next.remoteChanges = next.remoteChanges.filter(v => v.id !== id);
  const result = reconcileZenChanges(next, policies, now);
  if (!acknowledge) result.remoteChanges = result.remoteChanges.map(v => v.id === id && v.status === "pending" ? { ...v, status: "failed", lastError: "上次写入未获确认，请核对后手动重试。 / Previous write not confirmed; review before retry." } : v);
  return result;
}
export function acknowledgeZenWrite(data: ProjectData, id: string, task: ZenTask, policies: readonly Policy[], now = Date.now()): ProjectData {
  const q = data.remoteChanges?.find(v => v.id === id);
  if (!q || q.fields.some(k => remoteFields(task)[k] !== q.local[k])) fail("Write result requires verification");
  return updateVerifiedRemote(data, id, task, true, policies, now);
}
export function verifyZenChange(data: ProjectData, id: string, task: ZenTask, policies: readonly Policy[], now = Date.now()): ProjectData {
  const q = data.remoteChanges?.find(v => v.id === id), remote = remoteFields(task);
  const accepted = Boolean(q && q.fields.every(k => remote[k] === q.local[k]));
  return updateVerifiedRemote(data, id, task, accepted, policies, now);
}
export function recoverZenChanges(data: ProjectData): ProjectData {
  return { ...data, remoteChanges: (data.remoteChanges ?? []).map(q => q.status === "sending" ? { ...q, status: "uncertain", lastError: "上次提交结果待核实，请先刷新远端。 / Verify the previous write result first." } : q) };
}
