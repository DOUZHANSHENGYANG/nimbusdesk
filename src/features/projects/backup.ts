import { validateProjectData } from "./core";
import type { ProjectData } from "./types";
import { normalizeZenUrl, validateZenConnections } from "./zentao-core";
import { emptyZenSyncMeta, type ZenConnectionData } from "./zentao-types";

function merge<T extends { id: string; updatedAt?: number; notifiedAt?: number }>(local: T[], incoming: T[]): T[] {
  const values = new Map(local.map(v => [v.id, v]));
  for (const v of incoming) {
    const old = values.get(v.id);
    if (!old || (v.updatedAt ?? v.notifiedAt ?? 0) > (old.updatedAt ?? old.notifiedAt ?? 0)) values.set(v.id, v);
  }
  return [...values.values()];
}
export function mergeProjectBackup(local: ProjectData, incoming: ProjectData, opts = { overwriteSettings: false }): ProjectData {
  validateProjectData(local); validateProjectData(incoming);
  const memberships = merge(local.memberships, incoming.memberships);
  const pairs = new Map<string, (typeof memberships)[number]>();
  for (const m of memberships) {
    const key = JSON.stringify([m.itemId, m.iterationId]), old = pairs.get(key);
    if (!old || m.updatedAt > old.updatedAt) pairs.set(key, m);
  }
  const data: ProjectData = {
    areas: merge(local.areas, incoming.areas),
    projects: merge(local.projects, incoming.projects).map(p => ({ ...p, folder: local.projects.find(x => x.id === p.id)?.folder ?? null })),
    iterations: merge(local.iterations, incoming.iterations), items: merge(local.items, incoming.items),
    remoteTasks: merge(local.remoteTasks ?? [], incoming.remoteTasks ?? []), remoteExecutions: merge(local.remoteExecutions ?? [], incoming.remoteExecutions ?? []), remoteLinks: merge(local.remoteLinks ?? [], incoming.remoteLinks ?? []),
    // A backup cannot prove whether an external write happened on another machine.
    // Only intentions actually adopted from this backup lose their send-ready state.
    remoteChanges: merge(local.remoteChanges ?? [], (incoming.remoteChanges ?? []).map(change => ({ ...change, status: change.status === "conflict" ? "conflict" as const : "uncertain" as const }))),
    memberships: [...pairs.values()], reminderRule: opts.overwriteSettings ? incoming.reminderRule : local.reminderRule, deliveries: merge(local.deliveries, incoming.deliveries).slice(-4096),
  };
  // Conflicting active-iteration graphs must be reviewed, never silently detached.
  validateProjectData(data); return data;
}
export function assertPlanLinks(envelope: unknown, workItems: Set<string>, mergedItems = new Set<string>()): void {
  if (!envelope || typeof envelope !== "object") return;
  const box = envelope as { state?: { days?: Record<string, unknown> }; days?: Record<string, unknown> };
  const days = (box.state ?? box).days;
  for (const day of Object.values(days ?? {})) {
    const tasks = Array.isArray(day) ? day : (day as { tasks?: unknown[] })?.tasks ?? [];
    const planIds = new Set<string>();
    for (const entry of tasks) {
      const id = (entry as { workItemId?: unknown })?.workItemId;
      if (entry && Object.prototype.hasOwnProperty.call(entry, "workItemId")) {
        const planId = (entry as { id?: unknown }).id;
        if (typeof planId !== "string" || !planId.trim() || planIds.has(planId)) throw new Error("Backup has an invalid or duplicated linked plan ID");
        planIds.add(planId);
      }
      if (id != null && (typeof id !== "string" || !workItems.has(id))) throw new Error("Backup has a plan linked to a missing project task; restore the matching project data first.");
      if (typeof id === "string" && mergedItems.has(id)) throw new Error("Backup has a plan linked to a merged project task");
    }
  }
}

/** Restoring a recoverable merge also rewires older local plan references. */
export function rewriteMergedPlanLinks<T>(envelope: T, data: ProjectData): T {
  const next = structuredClone(envelope);
  if (!next || typeof next !== "object") return next;
  const box = next as { state?: { days?: Record<string, unknown> }; days?: Record<string, unknown> };
  const merged = new Map(data.items.filter(i => i.mergedIntoId).map(i => [i.id, i.mergedIntoId!]));
  for (const day of Object.values((box.state ?? box).days ?? {})) {
    const tasks = Array.isArray(day) ? day : (day as { tasks?: unknown[] })?.tasks ?? [];
    for (const entry of tasks) {
      const task = entry as { workItemId?: unknown } | null;
      if (task && typeof task.workItemId === "string" && merged.has(task.workItemId)) task.workItemId = merged.get(task.workItemId)!;
    }
  }
  return next;
}

function metadataFields(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error("Unsupported ZenTao backup metadata field; credentials cannot be backed up");
}

/** Validate the complete allowlist before copying any public metadata. */
export function readZenBackup(value: unknown): ZenConnectionData {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid ZenTao backup metadata");
  let state: unknown = value;
  if (Object.prototype.hasOwnProperty.call(value, "state")) {
    metadataFields(value, ["state", "version"]);
    if (value.version !== undefined && (!Number.isSafeInteger(value.version) || Number(value.version) < 0)) throw new Error("Invalid ZenTao backup metadata version");
    state = value.state;
  }
  metadataFields(state, ["connections", "syncStates"]);
  const data = state as unknown as ZenConnectionData;
  validateZenConnections(data);
  for (const profile of data.connections) metadataFields(profile, ["id", "name", "baseUrl", "account", "apiVersion", "executionIds", "autoSync", "syncMinutes", "createdAt", "updatedAt", "writeFields"]);
  for (const meta of Object.values(data.syncStates)) metadataFields(meta, ["lastSyncAt", "lastError", "lastCount", "resolvedVersion", "authRequired"]);
  return structuredClone(data);
}

/** Credentials are machine-local. A restored profile never starts networking. */
export function mergeZenBackup(local: ZenConnectionData, incoming: ZenConnectionData): ZenConnectionData {
  const next = readZenBackup(local), restored = readZenBackup(incoming);
  for (const profile of restored.connections) {
    const existing = next.connections.find(c => c.id === profile.id);
    const endpoint = (url: string) => url ? normalizeZenUrl(url) : "";
    if (existing && (endpoint(existing.baseUrl) !== endpoint(profile.baseUrl) || existing.account !== profile.account)) throw new Error("ZenTao connection identity conflicts with the local instance or account");
    const value = { ...(existing ?? profile), autoSync: false, writeFields: [] };
    if (existing) next.connections[next.connections.indexOf(existing)] = value;
    else next.connections.push(value);
    next.syncStates[profile.id] = { ...emptyZenSyncMeta(), ...(existing ? next.syncStates[profile.id] : restored.syncStates[profile.id]), lastError: null, authRequired: true };
  }
  validateZenConnections(next);
  return next;
}
