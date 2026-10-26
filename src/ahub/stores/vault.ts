import { create } from "zustand";
import { api } from "@/ahub/lib/api";
import type { VaultIndex, VaultStatus, VaultVersion } from "@/ahub/lib/types";

interface VaultState {
  /** 每个工具的配置有没有、在不在监视里、有没有改动 */
  status: VaultStatus[] | null;
  /** 监视名单 + 每个工具的配置版本 */
  index: VaultIndex | null;
  busy: boolean;
  load: () => Promise<void>;
  setWatched: (watched: string[]) => Promise<void>;
  snapshot: (harnesses: string[], kind?: string) => Promise<VaultVersion[]>;
  restore: (harness: string, v: number) => Promise<void>;
  clear: (harnesses: string[]) => Promise<void>;
  versionsOf: (harness: string) => VaultVersion[];
  statusOf: (harness: string) => VaultStatus | null;
}

/**
 * 配置版本库（vault）的前端唯一一份状态。
 *
 * 之前只有「配置版本」那一页在用它；工具卡也要显示/恢复自己那份配置的版本，
 * 两边各自取一份就会互相看过期数据（卡上打完快照，另一页还显示旧计数）。
 * 所以收成一个 store：工具卡与「全局」区块共用，谁动过谁刷新，大家看到的是同一份。
 */
export const useVault = create<VaultState>()((set, get) => ({
  status: null,
  index: null,
  busy: false,
  load: async () => {
    const [status, index] = await Promise.all([api.vaultStatus(), api.vaultIndex()]);
    set({ status, index });
  },
  setWatched: async (watched) => {
    set({ index: await api.vaultSetWatched(watched) });
  },
  snapshot: async (harnesses, kind = "manual") => {
    set({ busy: true });
    try {
      const saved = await api.vaultSnapshot(harnesses, kind);
      await get().load();
      return saved;
    } finally {
      set({ busy: false });
    }
  },
  restore: async (harness, v) => {
    set({ busy: true });
    try {
      await api.vaultRestore(harness, v);
      await get().load();
    } finally {
      set({ busy: false });
    }
  },
  clear: async (harnesses) => {
    set({ busy: true });
    try {
      await api.vaultClear(harnesses);
      await get().load();
    } finally {
      set({ busy: false });
    }
  },
  versionsOf: (harness) => get().index?.entries.find((entry) => entry.harness === harness)?.versions ?? [],
  statusOf: (harness) => get().status?.find((item) => item.harness === harness) ?? null,
}));
