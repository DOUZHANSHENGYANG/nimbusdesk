import type { StateStorage } from "zustand/middleware";
import { readJson, writeJson } from "@/lib/tauri";

/**
 * Zustand persist 适配器：落到自定义数据目录的 JSON 文件。
 * 写入做 trailing 防抖，避免高频 setState 连续落盘。
 */

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pending = new Map<string, unknown>();
const DEBOUNCE_MS = 250;

function flush(key: string) {
  const value = pending.get(key);
  if (value === undefined) return;
  pending.delete(key);
  void writeJson(key, value).catch((e) => console.error(`[storage] write ${key}:`, e));
}

export const tauriJsonStorage: StateStorage = {
  async getItem(name) {
    try {
      return await readJson<unknown>(name).then((v) =>
        v == null ? null : JSON.stringify(v),
      );
    } catch (e) {
      console.error(`[storage] read ${name}:`, e);
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
    try {
      await writeJson(name, null);
    } catch (e) {
      console.error(`[storage] remove ${name}:`, e);
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
