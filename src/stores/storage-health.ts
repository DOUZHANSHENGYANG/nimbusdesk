import { create } from "zustand";

/**
 * 落盘健康度。**唯一目的是让写失败可见**。
 *
 * 数据目录可能因为磁盘满、目录被删、权限变化、同步盘占用而写不进去。
 * 若只 `console.error`，用户改了分类名/编辑了任务、界面毫无反应，
 * 会以为已经保存 —— 这是最危险的一类静默失败（丢数据且用户不知情）。
 *
 * 因此所有落盘路径都收到这里，UI 顶部渲染一条告警条。
 */

export type StorageProblem = "write" | "remove" | "unavailable";

export interface StorageHealthState {
  problem: StorageProblem | null;
  /** 出问题的数据 key（如 `files`） */
  key: string | null;
  detail: string | null;
  at: number | null;
  report: (problem: StorageProblem, key: string, detail: string) => void;
  /** 某 key 写入成功后清掉针对它的告警（换 key 失败不影响） */
  clear: (key: string) => void;
  dismiss: () => void;
}

export const useStorageHealth = create<StorageHealthState>()((set) => ({
  problem: null,
  key: null,
  detail: null,
  at: null,

  report: (problem, key, detail) =>
    set((s) => {
      // 同一 key 反复失败（每次防抖写都会失败）不必刷新时间戳之外的任何东西
      if (s.problem === problem && s.key === key && s.detail === detail) return s;
      console.error(`[storage] ${problem} ${key}:`, detail);
      return { problem, key, detail, at: Date.now() };
    }),

  clear: (key) =>
    set((s) => (s.key === key || s.key === null ? { problem: null, key: null, detail: null, at: null } : s)),

  dismiss: () => set({ problem: null, key: null, detail: null, at: null }),
}));

/** 供非 React 代码（storage 适配器）调用，避免在模块里 import hook 的 setState */
export const storageHealth = useStorageHealth;
