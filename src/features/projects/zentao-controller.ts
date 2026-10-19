import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { acceptCommittedStorage, flushAllStorage } from "@/lib/storage";
import { readJson } from "@/lib/tauri";
import { useStorageHealth } from "@/stores/storage-health";
import { usePlans, usePlansArchive } from "@/features/plans/store";
import { useProjects, projectData } from "./store";
import { useZentao } from "./zentao-store";
import { applyZenSnapshot, buildZenBinding, normalizeZenUrl } from "./zentao-core";
import { validateProjectData } from "./core";
import { reconcileZenChanges } from "./zentao-writeback-core";
import { emptyZenSyncMeta, type ZenFields, type ZenFetchResult, type ZenSecretStatus, type ZenTestResult, type ZenSyncMeta } from "./zentao-types";
import type { ProjectData } from "./types";
import type { PlanTask, ArchivedDay } from "../plans/types";

export const useZentaoRuntimeState = create<{ busy: Record<string, boolean> }>()(() => ({ busy: {} }));
let binding = false;
function assertReady() {
  if (![useZentao, useProjects, usePlans, usePlansArchive].every(s => s.persist.hasHydrated())) throw new Error("Project data is still loading");
  const health = useStorageHealth.getState();
  if (health.problem === "unavailable") throw new Error("Storage is unavailable; reload before syncing");
}
function connection(id: string) { assertReady(); const c = useZentao.getState().connections.find(v => v.id === id); if (!c) throw new Error("Connection unavailable"); return c; }
function meta(id: string, patch: Partial<ZenSyncMeta>) {
  if (!useZentao.getState().connections.some(c => c.id === id)) return;
  useZentao.setState(s => ({ syncStates: { ...s.syncStates, [id]: { ...emptyZenSyncMeta(), ...s.syncStates[id], ...patch } } }));
}
function safeError(error: unknown): Error {
  const code = String(error).match(/ZENTAO_[A-Z_]+/)?.[0];
  const message = code === "ZENTAO_AUTH_REQUIRED" ? "认证已失效，请重新测试连接。 / Authentication required."
    : code === "ZENTAO_ACCOUNT_MISMATCH" ? "Token 所属账号与配置不一致，请核对账号。 / Token account does not match."
    : code === "ZENTAO_INVALID_CONFIG" || code === "ZENTAO_INVALID_URL" ? "连接设置或同步范围无效，请检查配置。 / Invalid connection configuration."
    : code === "ZENTAO_REDIRECT_BLOCKED" ? "接口返回了重定向，请检查最终禅道地址和登录方式。 / Check the final instance URL and authentication method."
    : code === "ZENTAO_FORBIDDEN" ? "账号无权读取这些任务。 / Access denied."
    : code === "ZENTAO_RATE_LIMITED" ? "请求过于频繁，请稍后重试。 / Rate limited."
    : code?.includes("PAGINATION") || code?.includes("RESPONSE") ? "禅道响应或分页不完整，已保留原缓存。 / Incomplete response; cache retained."
    : "连接或同步未完成，已保留原数据。请检查配置后重试。 / Operation failed; previous data retained.";
  return Object.assign(new Error(message), { code });
}
export async function exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
  connection(id);
  if (binding || useZentaoRuntimeState.getState().busy[id]) throw new Error("A ZenTao operation is already in progress");
  useZentaoRuntimeState.setState(s => ({ busy: { ...s.busy, [id]: true } }));
  try { return await operation(); }
  finally { useZentaoRuntimeState.setState(s => ({ busy: { ...s.busy, [id]: false } })); }
}
export async function getZenSecretStatus(id: string): Promise<ZenSecretStatus> {
  connection(id); await flushAllStorage();
  try { return await invoke("zentao_secret_status", { connectionId: id }); } catch (e) { throw safeError(e); }
}
export async function testZenConnection(id: string, password?: string, token?: string): Promise<ZenTestResult> {
  return exclusive(id, async () => {
    await flushAllStorage();
    try {
      const result = await invoke<ZenTestResult>("zentao_test_connection", { connectionId: id, password, token });
      meta(id, { authRequired: false, lastError: null, resolvedVersion: result.apiVersion }); await flushAllStorage(); return result;
    } catch (error) { const e = safeError(error); meta(id, { lastError: e.message, authRequired: true }); await flushAllStorage(); throw e; }
  });
}
export async function forgetZenSecret(id: string): Promise<void> {
  return exclusive(id, async () => {
    await flushAllStorage();
    try { await invoke("zentao_forget_secret", { connectionId: id }); }
    catch (e) { throw safeError(e); }
    meta(id, { authRequired: true }); await flushAllStorage();
  });
}
export async function syncZenConnection(id: string): Promise<void> {
  return exclusive(id, async () => {
    await flushAllStorage();
    if (useZentao.getState().syncStates[id]?.authRequired) throw new Error("Verify the connection before syncing again");
    const identity = JSON.stringify(connection(id));
    try {
      const trackedIds = useProjects.getState().remoteLinks.filter(v => v.connectionId === id).map(v => v.remoteId);
      const result = await invoke<ZenFetchResult>("zentao_fetch_tasks", { connectionId: id, trackedIds });
      if (identity !== JSON.stringify(connection(id))) throw new Error("ZENTAO_CONNECTION_CHANGED");
      // Use the current state after IO so edits made while fetching are preserved.
      const applied = applyZenSnapshot(projectData(useProjects.getState()), id, result);
      const data = reconcileZenChanges(applied.data, useZentao.getState().connections);
      validateProjectData(data); useProjects.setState(data); await flushAllStorage();
      meta(id, { lastSyncAt: result.fetchedAt, lastCount: new Set(result.tasks.map(t => t.id)).size, lastError: result.unavailableIds.length ? `${result.unavailableIds.length} 条已绑定任务暂不可访问，已保留缓存。 / Bound task cache retained.` : null, resolvedVersion: result.apiVersion, authRequired: false });
      await flushAllStorage();
    } catch (error) {
      const e = safeError(error); meta(id, { lastError: e.message, authRequired: ["ZENTAO_AUTH_REQUIRED", "ZENTAO_FORBIDDEN"].includes((e as Error & { code?: string }).code ?? "") });
      await flushAllStorage(); throw e;
    }
  });
}
type Envelope<T> = { state: T; version: number };
type Bundle = { projects: Envelope<ProjectData>; plans: Envelope<{ days: Record<string, PlanTask[]> }> | null; archive: Envelope<{ days: Record<string, ArchivedDay> }> | null };
function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => [k, canonical(v)])) : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
async function readBundle(): Promise<Bundle> {
  const [projects, plans, archive] = await Promise.all([readJson<Bundle["projects"]>("projects"), readJson<Bundle["plans"]>("plans"), readJson<Bundle["archive"]>("plans-archive")]);
  if (!projects?.state) throw new Error("Project data unavailable");
  return { projects, plans, archive };
}
async function commitBundle(next: Bundle, base: Bundle): Promise<Bundle> {
  const saved = await invoke<Bundle>("project_apply_remote_binding", { ...next, baseProjects: base.projects, basePlans: base.plans, baseArchive: base.archive });
  const snapshot = structuredClone(saved);
  await acceptCommittedStorage({ projects: saved.projects, plans: saved.plans, "plans-archive": saved.archive }); return snapshot;
}
async function withBinding<T>(work: () => Promise<T>): Promise<T> {
  assertReady();
  if (binding || Object.values(useZentaoRuntimeState.getState().busy).some(Boolean)) throw new Error("A ZenTao operation is already in progress");
  binding = true;
  try { await flushAllStorage(); return await work(); } finally { binding = false; }
}
export async function bindZenTask(itemId: string, remoteTaskId: string, choices: Partial<Record<keyof ZenFields, "local" | "remote">> = {}): Promise<{ undo?: () => Promise<void> }> {
  return withBinding(async () => {
    const before = await readBundle();
    const result = buildZenBinding(before.projects.state, before.plans?.state.days ?? {}, before.archive?.state.days ?? {}, itemId, remoteTaskId, choices);
    result.data = reconcileZenChanges(result.data, useZentao.getState().connections);
    validateProjectData(result.data);
    const next: Bundle = { projects: { ...before.projects, state: result.data }, plans: { version: before.plans?.version ?? 4, state: { ...before.plans?.state, days: result.plans } }, archive: { version: before.archive?.version ?? 3, state: { ...before.archive?.state, days: result.archive } } };
    const after = await commitBundle(next, before);
    // A native three-way merge may include another window's edits. A full inverse
    // snapshot would erase those edits, so only offer undo for the exact proposal.
    if (!sameJson(after, next)) return {};
    return { undo: () => withBinding(async () => {
      const current = await readBundle();
      if (!sameJson(current, after)) throw new Error("Data changed after binding; review before undoing");
      await commitBundle(before, current);
    }) };
  });
}
export async function openZenTask(remoteTaskId: string): Promise<void> {
  const task = useProjects.getState().remoteTasks.find(t => t.id === remoteTaskId); if (!task) throw new Error("Task unavailable");
  const c = connection(task.connectionId), url = new URL(`task-view-${task.remoteId}.html`, normalizeZenUrl(c.baseUrl));
  await openUrl(url.toString());
}
