import type { StateStorage } from "zustand/middleware";
import { emit, listen } from "@tauri-apps/api/event";
import { readJson, writeJson, inTauri } from "@/lib/tauri";
import { useStorageHealth, type StorageProblem } from "@/stores/storage-health";

// Serialize writes per WebView. SQLite merges against the snapshot edited here.
type Write = { value: unknown; base: unknown };
const pending = new Map<string, Write>();
const active = new Map<string, Promise<void>>();
const writing = new Map<string, Write>();
const known = new Map<string, unknown>();
const blocked = new Set<string>();
const applying = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const handlers = new Set<(key: string, value: unknown) => void>();
const source = crypto.randomUUID();
const reads = new Map<string, number>();
const EV_STORAGE = "storage://changed";

export function onStorageSynced(fn: (key: string, value: unknown) => void): () => void {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

function reportFailure(problem: StorageProblem, key: string, error: unknown) {
  useStorageHealth.getState().report(problem, key, error instanceof Error ? error.message : String(error));
}

function applyRemote(key: string, value: unknown) {
  known.set(key, value);
  applying.add(key);
  try { for (const handler of handlers) handler(key, value); }
  finally { applying.delete(key); }
}

function clearTimer(key: string) {
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
}

function flush(key: string): Promise<void> {
  clearTimer(key);
  const existing = active.get(key);
  if (existing) return existing;
  const run = (async () => {
    while (pending.has(key)) {
      if (blocked.has(key)) throw new Error("读取失败，已暂停写入，避免覆盖原数据。请修复存储后重新加载。");
      const entry = pending.get(key)!;
      pending.delete(key);
      writing.set(key, entry);
      try {
        const saved = await writeJson(key, entry.value, { value: entry.base });
        const canonical = saved === undefined ? entry.value : saved;
        known.set(key, canonical);
        useStorageHealth.getState().clear(key);
        if (!pending.has(key)) applyRemote(key, canonical);
        if (inTauri) await emit(EV_STORAGE, { key, source }).catch(() => undefined);
      } catch (error) {
        const next = pending.get(key);
        pending.set(key, next ? { value: next.value, base: entry.base } : entry);
        reportFailure("write", key, error);
        throw error;
      } finally { writing.delete(key); }
    }
  })();
  active.set(key, run);
  void run.finally(() => { if (active.get(key) === run) active.delete(key); }).catch(() => undefined);
  return run;
}

function enqueue(key: string, value: unknown) {
  if (applying.has(key)) return;
  reads.set(key, (reads.get(key) ?? 0) + 1);
  const previous = pending.get(key);
  pending.set(key, { value, base: previous ? previous.base : writing.has(key) ? writing.get(key)!.value : known.get(key) ?? null });
  clearTimer(key);
  timers.set(key, setTimeout(() => { void flush(key).catch(() => undefined); }, 250));
}

if (inTauri) {
  void listen<{ key: string; source?: string }>(EV_STORAGE, async ({ payload }) => {
    const { key } = payload;
    if (payload.source === source) return;
    const generation = (reads.get(key) ?? 0) + 1;
    reads.set(key, generation);
    try {
      await flush(key);
      const value = await readJson<unknown>(key);
      if (reads.get(key) === generation && !pending.has(key) && !writing.has(key)) applyRemote(key, value);
    } catch (error) { reportFailure("unavailable", key, error); }
  }).catch(() => undefined);
}

export const tauriJsonStorage: StateStorage = {
  async getItem(name) {
    try {
      const value = await readJson<unknown>(name);
      known.set(name, value);
      blocked.delete(name);
      return value == null ? null : JSON.stringify(value);
    } catch (error) {
      blocked.add(name);
      reportFailure("unavailable", name, error);
      return null;
    }
  },
  async setItem(name, value) { enqueue(name, JSON.parse(value)); },
  async removeItem(name) { enqueue(name, null); await flush(name); },
};

/** Wait for queued/in-flight writes before closing, backup or moving data. */
export async function flushAllStorage(): Promise<void> {
  while (pending.size || active.size) {
    await Promise.all([...new Set([...pending.keys(), ...active.keys()])].map(flush));
  }
}
