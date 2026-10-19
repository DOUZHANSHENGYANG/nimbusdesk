import { invoke } from "@tauri-apps/api/core";
import { flushAllStorage } from "@/lib/storage";
import { useProjects, projectData } from "./store";
import { useZentao } from "./zentao-store";
import { exclusive } from "./zentao-controller";
import { applyZenSnapshot } from "./zentao-core";
import { validateProjectData } from "./core";
import { acknowledgeZenWrite, prepareZenWrite, reconcileZenChanges, resolveZenChange, verifyZenChange, type ZenSelections } from "./zentao-writeback-core";
import { emptyZenSyncMeta, type ZenChange, type ZenTask } from "./zentao-types";
import type { ProjectData } from "./types";
import { ZEN_FIELD_KEYS } from "./zentao-fields";

function source(id: string) {
  const link = useProjects.getState().remoteLinks.find(l => l.id === id);
  const connection = useZentao.getState().connections.find(c => c.id === link?.connectionId);
  if (!link || !connection) throw new Error("来源关联已变化，请重新打开工作项。 / Source binding changed.");
  if (useZentao.getState().syncStates[connection.id]?.authRequired) throw new Error("请先验证禅道连接。 / Verify the connection first.");
  return { link, connection };
}
async function save(data: ProjectData) {
  validateProjectData(data); useProjects.setState(data); await flushAllStorage();
}
function errorCode(error: unknown) { return String(error).match(/ZENTAO_[A-Z_]+/)?.[0] ?? ""; }
function safeWriteError(error: unknown): Error {
  const code = errorCode(error);
  const message = code === "ZENTAO_REMOTE_CHANGED" ? "远端内容已变化，请查看最新比较后再处理。 / Remote content changed; review again."
    : code === "ZENTAO_READ_ONLY" ? "请先在连接设置中启用需要回写的字段。 / Enable the desired writable fields first."
    : code === "ZENTAO_AUTH_REQUIRED" || code === "ZENTAO_FORBIDDEN" ? "认证或权限不足，请重新验证连接。 / Check authentication and permissions."
    : code === "ZENTAO_INTENT_CHANGED" || code === "ZENTAO_CONNECTION_CHANGED" || code === "ZENTAO_TASK_NOT_BOUND" ? "连接、任务关联或待发送内容已变化，请重新核对。 / The connection or queued change was modified."
    : "操作未确认完成，请刷新远端核实结果后再处理。 / Refresh the remote task to verify the result.";
  return new Error(message);
}
function identity(id: string) {
  const s = source(id); return JSON.stringify([s.link.itemId, s.connection.id, s.connection.baseUrl, s.connection.account, s.connection.apiVersion]);
}
async function refresh(id: string): Promise<void> {
  const { link, connection } = source(id), initial = identity(id);
  const old = useProjects.getState().remoteChanges?.find(q => q.id === id);
  if (old?.status === "sending") throw new Error("正在发送，请等待结果。 / A write is still in progress.");
  const task = await invoke<ZenTask>("zentao_read_task", { connectionId: connection.id, remoteId: link.remoteId });
  if (initial !== identity(id)) throw new Error("ZENTAO_CONNECTION_CHANGED");
  const data = projectData(useProjects.getState()), q = data.remoteChanges.find(v => v.id === id), policies = useZentao.getState().connections;
  const next = q?.status === "uncertain"
    ? verifyZenChange(data, id, task, policies)
    : reconcileZenChanges(applyZenSnapshot(data, connection.id, { apiVersion: "v1", tasks: [task], executions: [], unavailableIds: [], fetchedAt: Date.now() }).data, policies);
  await save(next);
}
export async function refreshZenTask(id: string): Promise<void> {
  const { connection } = source(id);
  return exclusive(connection.id, async () => {
    await flushAllStorage();
    try { await refresh(id); } catch (error) { throw safeWriteError(error); }
  });
}
export async function resolveZenChanges(id: string, selections: ZenSelections, expectedUpdatedAt: number): Promise<void> {
  const { connection } = source(id);
  return exclusive(connection.id, async () => {
    await flushAllStorage();
    const previous = useProjects.getState().remoteChanges?.find(q => q.id === id);
    if (!previous || previous.updatedAt !== expectedUpdatedAt) throw new Error("比较已变化，请重新选择。 / Comparison changed; choose again.");
    try { await refresh(id); } catch (error) { throw safeWriteError(error); }
    // A fresh GET invalidates stale choices if any of the compared fields changed.
    const data = resolveZenChange(projectData(useProjects.getState()), id, selections, expectedUpdatedAt, useZentao.getState().connections);
    await save(data);
  });
}
async function retainResult(id: string, fallback: ZenChange, status: "uncertain" | "failed", message: string) {
  const data = projectData(useProjects.getState());
  const link = data.remoteLinks.find(l => l.id === id);
  if (!link || link.itemId !== fallback.itemId) return;
  const change: ZenChange = { ...fallback, status, lastError: message, updatedAt: Math.max(Date.now(), fallback.updatedAt + 1) };
  await save({ ...data, remoteChanges: [...data.remoteChanges.filter(q => q.id !== id), change] });
}
function reviewFingerprint(q?: ZenChange) {
  return q ? JSON.stringify([q.id, q.connectionId, q.remoteId, q.itemId, q.status, q.fields, q.lastError, q.updatedAt,
    ...([q.base, q.local, q.remote, q.expected].map(value => ZEN_FIELD_KEYS.map(key => value[key])))]) : "";
}
export async function sendZenChanges(id: string, expectedUpdatedAt?: number): Promise<void> {
  const { connection } = source(id);
  const reviewed = useProjects.getState().remoteChanges.find(q => q.id === id);
  if (!reviewed || (expectedUpdatedAt !== undefined && reviewed.updatedAt !== expectedUpdatedAt)) throw new Error("Comparison changed; review before sending.");
  const fingerprint = reviewFingerprint(reviewed);
  return exclusive(connection.id, async () => {
    await flushAllStorage();
    const reconciled = reconcileZenChanges(projectData(useProjects.getState()), useZentao.getState().connections);
    if (fingerprint !== reviewFingerprint(reconciled.remoteChanges.find(q => q.id === id))) throw new Error("Comparison changed; review before sending.");
    const prepared = prepareZenWrite(projectData(useProjects.getState()), id, useZentao.getState().connections);
    const intent = prepared.data.remoteChanges.find(q => q.id === id)!;
    // Persist the exact proposal before the first possible remote mutation.
    await save(prepared.data);
    try {
      const result = await invoke<ZenTask>("zentao_write_task", { connectionId: connection.id, remoteId: intent.remoteId, expected: prepared.expected, changes: prepared.changes });
      const data = acknowledgeZenWrite(projectData(useProjects.getState()), id, result, useZentao.getState().connections);
      await save(data);
    } catch (error) {
      const code = errorCode(error), safe = safeWriteError(error);
      const refused = ["ZENTAO_REMOTE_CHANGED", "ZENTAO_READ_ONLY", "ZENTAO_INVALID_WRITE", "ZENTAO_AUTH_REQUIRED", "ZENTAO_FORBIDDEN", "ZENTAO_BUSY", "ZENTAO_INTENT_CHANGED", "ZENTAO_CONNECTION_CHANGED", "ZENTAO_TASK_NOT_BOUND", "ZENTAO_NETWORK_ERROR", "ZENTAO_TIMEOUT"].includes(code);
      await retainResult(id, intent, refused ? "failed" : "uncertain", safe.message);
      if (["ZENTAO_AUTH_REQUIRED", "ZENTAO_FORBIDDEN"].includes(code) && useZentao.getState().connections.some(c => c.id === connection.id)) useZentao.setState(s => ({ syncStates: { ...s.syncStates, [connection.id]: { ...emptyZenSyncMeta(), ...s.syncStates[connection.id], authRequired: true } } }));
      if (code === "ZENTAO_REMOTE_CHANGED") { try { await refresh(id); } catch { /* Retain the failed intent if fresh comparison is unavailable. */ } }
      await flushAllStorage(); throw safe;
    }
  });
}
