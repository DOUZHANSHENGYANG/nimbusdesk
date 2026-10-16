import type { StateStorage } from "zustand/middleware";
import { emit, listen } from "@tauri-apps/api/event";
import { readJson, writeJson, inTauri } from "@/lib/tauri";
import { useStorageHealth, type StorageProblem } from "@/stores/storage-health";

/**
 * Zustand persist 适配器：落到自定义数据目录的 JSON 文件。
 * 写入做 trailing 防抖，避免高频 setState 连续落盘。
 *
 * 跨窗口同步：栅栏是独立 WebView，各自有一份 store 内存副本。
 * 任一窗口写盘后广播 key，其他窗口收到后重读该 key 并回灌 store，
 * 否则会出现「主窗口改了分类名、栅栏还显示旧名」这类不同步。
 */

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pending = new Map<string, unknown>();
const DEBOUNCE_MS = 250;

/** 本窗口自己写入的 key → 时间戳，用于忽略自己发出的广播（防回声） */
const selfWrites = new Map<string, number>();
const ECHO_WINDOW_MS = 1500;

const EV_STORAGE = "storage://changed";

/** 收到其他窗口的写盘通知时调用（由各 store 注册回灌逻辑） */
type SyncHandler = (key: string, value: unknown) => void;
const handlers = new Set<SyncHandler>();

/** 注册跨窗口同步回调；返回取消函数 */
export function onStorageSynced(fn: SyncHandler): () => void {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

if (inTauri) {
  void listen<{ key: string }>(EV_STORAGE, async (e) => {
    const { key } = e.payload;
    // 自己刚写过的忽略，避免回灌覆盖本地更新的状态
    const mine = selfWrites.get(key);
    if (mine && Date.now() - mine < ECHO_WINDOW_MS) return;
    try {
      const value = await readJson<unknown>(key);
      if (value == null) return;
      for (const fn of handlers) fn(key, value);
    } catch (err) {
      console.error(`[storage] sync ${key}:`, err);
    }
  }).catch(() => undefined);
}

/** 把失败收进 storageHealth（唯一出口），UI 顶部据此渲染告警条 */
function reportFailure(problem: StorageProblem, key: string, e: unknown) {
  useStorageHealth.getState().report(problem, key, e instanceof Error ? e.message : String(e));
}

function flush(key: string) {
  const value = pending.get(key);
  if (value === undefined) return;
  pending.delete(key);
  selfWrites.set(key, Date.now());
  void writeJson(key, value)
    .then(() => {
      // 该 key 恢复正常 → 撤掉它的告警（只撤自己，别的 key 还在失败就留着）
      useStorageHealth.getState().clear(key);
      // 落盘成功后再广播，保证其他窗口读到的是新值
      if (inTauri) void emit(EV_STORAGE, { key }).catch(() => undefined);
    })
    .catch((e) => reportFailure("write", key, e));
}

export const tauriJsonStorage: StateStorage = {
  async getItem(name) {
    // 读失败也不能静默：读不回来 = 界面数据全丢了，用户必须知道
    try {
      return await readJson<unknown>(name).then((v) =>
        v == null ? null : JSON.stringify(v),
      );
    } catch (e) {
      reportFailure("unavailable", name, e);
      return null;
    }
  },
  async setItem(name, value) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return;
    }
    pending.set(name, parsed);
    const t = timers.get(name);
    if (t) clearTimeout(t);
    timers.set(
      name,
      setTimeout(() => {
        timers.delete(name);
        flush(name);
      }, DEBOUNCE_MS),
    );
  },
  async removeItem(name) {
    const t = timers.get(name);
    if (t) clearTimeout(t);
    timers.delete(name);
    pending.delete(name);
    selfWrites.set(name, Date.now());
    try {
      await writeJson(name, null);
      useStorageHealth.getState().clear(name);
      if (inTauri) void emit(EV_STORAGE, { key: name }).catch(() => undefined);
    } catch (e) {
      reportFailure("remove", name, e);
    }
  },
};

/** 立即落盘所有待写（供退出/迁移前调用） */
export function flushAllStorage() {
  for (const key of [...pending.keys()]) {
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.delete(key);
    flush(key);
  }
}
