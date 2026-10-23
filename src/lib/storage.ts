import type { StateStorage } from "zustand/middleware";
import { emit, listen } from "@tauri-apps/api/event";
import { readJson, writeJson, writePlanPair, inTauri } from "@/lib/tauri";
import { useStorageHealth, type StorageProblem } from "@/stores/storage-health";

// Serialize writes per WebView. SQLite merges against the snapshot edited here.
type Write = { value: unknown; base: unknown };
const pending = new Map<string, Write>();
const active = new Map<string, Promise<void>>();
const writing = new Map<string, Write>();
const known = new Map<string, unknown>();
/**
 * 每个 key 最后一次「确认已在磁盘上」的序列化文本，用来跳过一模一样的重写。
 *
 * zustand persist 每次 `set()` 都会调 `setItem`，不看内容有没有变；而这个应用里
 * 不少 `set` 只动了不持久化的字段（或原样回写），于是整份文档被重新序列化、
 * 走一趟 IPC、再让 SQLite 写一遍。命中这里就什么都不做。
 *
 * 只记录**确定和磁盘一致**的文本，且只在两种时机更新：刚读到（`getItem`）、
 * 刚写完（原生没返回不同版本时）。写入失败、或原生合并返回了不同内容，
 * 就把它删掉 —— 宁可多写一次，也不能因为「以为是同一份」而漏写。
 */
const sent = new Map<string, string>();
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

/** Publish the canonical result of a native transaction without echo-writing it.
 * Edits queued during the transaction retain their original merge base. */
export async function acceptCommittedStorage(values: Record<string, unknown>): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    reads.set(key, (reads.get(key) ?? 0) + 1);
    known.set(key, value);
    // 这份内容已经落盘了：去重记录跟上，免得下次原样回写时又是一次多余的 IPC
    rememberCommitted(key, value);
    if (!pending.has(key) && !writing.has(key)) applyRemote(key, value);
    useStorageHealth.getState().clear(key);
  }
  if (inTauri) for (const key of Object.keys(values)) await emit(EV_STORAGE, { key, source }).catch(() => undefined);
}

/** 把「磁盘上现在就是这份内容」记进去重表（value 为 null 表示这个 key 已被删掉）。 */
function rememberCommitted(key: string, value: unknown) {
  if (value == null) sent.delete(key);
  else sent.set(key, JSON.stringify(value));
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
  if ((key === "plans" || key === "plans-archive") && pending.has("plans") && pending.has("plans-archive")) {
    const other = active.get(key === "plans" ? "plans-archive" : "plans");
    if (other) return other.then(() => flush(key));
    return flushPlanPair();
  }
  const run = (async () => {
    while (pending.has(key)) {
      if (blocked.has(key) || ((key === "plans" || key === "plans-archive") && (blocked.has("plans") || blocked.has("plans-archive")))) throw new Error("读取失败，已暂停写入，避免覆盖原数据。请修复存储后重新加载。");
      const entry = pending.get(key)!;
      pending.delete(key);
      writing.set(key, entry);
      try {
        const saved = await writeJson(key, entry.value, { value: entry.base });
        const canonical = saved === undefined ? entry.value : saved;
        known.set(key, canonical);
        // 原生合并没改动内容 → 磁盘上就是我们发出去的那份，留着去重记录；
        // 内容被合并改过（别的窗口动过）→ 我们不知道磁盘实际长什么样，删掉记录。
        if (saved !== undefined && JSON.stringify(canonical) !== JSON.stringify(entry.value)) sent.delete(key);
        useStorageHealth.getState().clear(key);
        if (!pending.has(key)) applyRemote(key, canonical);
        if (inTauri) await emit(EV_STORAGE, { key, source }).catch(() => undefined);
      } catch (error) {
        sent.delete(key);
        const next = pending.get(key);
        pending.set(key, next ? { value: next.value, base: entry.base } : entry);
        reportFailure("write", key, error);
        throw error;
      } finally { writing.delete(key); }
      // A transition may arrive behind an ordinary in-flight plan edit. Do not
      // drain its first half here; the pair scheduler must commit both halves.
      if ((key === "plans" || key === "plans-archive") && pending.has("plans") && pending.has("plans-archive")) break;
    }
  })();
  active.set(key, run);
  const release = () => { if (active.get(key) === run) active.delete(key); };
  void run.then(() => {
    release();
    // Both debounce callbacks may have fired while independent single writes
    // were active. Hand pending transitions back immediately on success; failed
    // writes intentionally stay queued for explicit retry, without a hot loop.
    if ((key === "plans" || key === "plans-archive") && pending.has("plans") && pending.has("plans-archive")) void flush(key).catch(() => undefined);
  }, release);
  return run;
}

/** Archive/restore/undo touch both stores synchronously. Drain them as a single
 * native SQLite transaction, including retries and writes queued while in flight. */
function flushPlanPair(): Promise<void> {
  const keys = ["plans", "plans-archive"] as const;
  for (const key of keys) clearTimer(key);
  const run = (async () => {
    while (keys.some(key => pending.has(key))) {
      if (keys.some(key => blocked.has(key))) throw new Error("Plan data could not be loaded; writes are paused.");
      const entries = keys.map(key => pending.get(key) ?? { value: known.get(key) ?? null, base: known.get(key) ?? null });
      keys.forEach((key, i) => { pending.delete(key); writing.set(key, entries[i]); });
      try {
        const saved = await writePlanPair(entries[0].value, entries[1].value, entries[0].base, entries[1].base);
        const canonical = [saved.plans, saved.archive];
        keys.forEach((key, i) => {
          known.set(key, canonical[i]);
          if (JSON.stringify(canonical[i]) !== JSON.stringify(entries[i].value)) sent.delete(key);
          useStorageHealth.getState().clear(key);
          if (!pending.has(key)) applyRemote(key, canonical[i]);
        });
        if (inTauri) for (const key of keys) await emit(EV_STORAGE, { key, source }).catch(() => undefined);
      } catch (error) {
        keys.forEach(key => sent.delete(key));
        keys.forEach((key, i) => { const next = pending.get(key); pending.set(key, next ? { value: next.value, base: entries[i].base } : entries[i]); reportFailure("write", key, error); });
        throw error;
      } finally { keys.forEach(key => writing.delete(key)); }
    }
  })();
  keys.forEach(key => active.set(key, run));
  void run.finally(() => keys.forEach(key => { if (active.get(key) === run) active.delete(key); })).catch(() => undefined);
  return run;
}

/** 写入防抖：普通文档 250 ms；大文档拉长到 1.2 s（见 `debounceFor`）。 */
const DEBOUNCE_MS = 250;
const BIG_DEBOUNCE_MS = 1200;
/** 超过这个体积就算「大文档」：一次写入 = 整份序列化 + IPC + SQLite 重写整行。 */
const BIG_PAYLOAD_BYTES = 512 * 1024;

/**
 * 按载荷大小决定批处理窗口。
 *
 * 实测（真实形状的合成数据）：`files` 2000 条 ≈ 0.6 MB、8000 条 ≈ 2.5 MB，`plans` 3 年 ≈ 1.5 MB ——
 * 这种文档写一次就是「整份序列化 + 一次 IPC + SQLite 重写整行」，单次 5–25 ms。
 * 连续拖动/输入时 250 ms 窗口意味着每秒最多四次这样的全量往返，主线程与磁盘都在白忙。
 * 大文档把窗口拉到 1.2 s（期间所有改动合并成一次写）；窗口隐藏/卸载前仍会立即落盘兜底
 * （见文件末尾的 `visibilitychange`/`pagehide` 监听）。
 */
function debounceFor(raw?: string): number {
  return raw !== undefined && raw.length > BIG_PAYLOAD_BYTES ? BIG_DEBOUNCE_MS : DEBOUNCE_MS;
}

function enqueue(key: string, value: unknown, raw?: string) {
  if (applying.has(key)) return;
  if (raw !== undefined) {
    // 内容与磁盘上的那份一致：不排队、不重写（见 `sent` 的说明）
    if (sent.get(key) === raw) return;
    sent.set(key, raw);
  }
  reads.set(key, (reads.get(key) ?? 0) + 1);
  const previous = pending.get(key);
  pending.set(key, { value, base: previous ? previous.base : writing.has(key) ? writing.get(key)!.value : known.get(key) ?? null });
  clearTimer(key);
  timers.set(key, setTimeout(() => { void flush(key).catch(() => undefined); }, debounceFor(raw)));
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
      if (reads.get(key) === generation && !pending.has(key) && !writing.has(key)) {
        rememberCommitted(key, value);
        applyRemote(key, value);
      }
    } catch (error) { reportFailure("unavailable", key, error); }
  }).catch(() => undefined);
}

export const tauriJsonStorage: StateStorage = {
  async getItem(name) {
    try {
      const value = await readJson<unknown>(name);
      known.set(name, value);
      blocked.delete(name);
      if (value == null) { sent.delete(name); return null; }
      const text = JSON.stringify(value);
      sent.set(name, text);
      return text;
    } catch (error) {
      blocked.add(name);
      // 读失败时不知道磁盘内容，去重记录必须清掉，否则下一次写可能被误判为「没变」
      sent.delete(name);
      reportFailure("unavailable", name, error);
      return null;
    }
  },
  async setItem(name, value) { enqueue(name, JSON.parse(value), value); },
  async removeItem(name) { sent.delete(name); enqueue(name, null); await flush(name); },
};

/** Wait for queued/in-flight writes before closing, backup or moving data. */
export async function flushAllStorage(): Promise<void> {
  while (pending.size || active.size) {
    await Promise.all([...new Set([...pending.keys(), ...active.keys()])].map(flush));
  }
}

/*
 * 兜底落盘：大文档的批处理窗口是 1.2 s，如果用户在这期间切走/关窗，那份改动还躺在内存里。
 * 窗口不可见或要卸载时立即把队列排空 —— 代价极小（本来也该写），换来的是「后台不留悬写」。
 */
if (typeof document !== "undefined") {
  const flushNow = () => {
    void flushAllStorage().catch(() => undefined);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushNow();
  });
  window.addEventListener("pagehide", flushNow);
}
