import { create } from "zustand";
import { api } from "@/ahub/lib/api";
import type { UpstreamRow } from "@/ahub/components/UpstreamCheckDialog";

/** 后台检查节奏：启动后 1 分钟跑第一次，之后每 6 小时一次。自动应用不做，只报数。 */
const FIRST_DELAY_MS = 60 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

interface WatchState {
  /** 有上游更新的技能数 —— 侧栏角标用 */
  count: number;
  lastCheckedAt: string;
  checking: boolean;
  setRows: (rows: UpstreamRow[]) => void;
  check: (dirNames?: string[]) => Promise<void>;
  start: () => void;
  stop: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let firstTimer: ReturnType<typeof setTimeout> | null = null;

export const useUpstreamWatch = create<WatchState>((set, get) => ({
  count: 0,
  lastCheckedAt: "",
  checking: false,
  setRows: (rows) => set({ count: rows.filter((row) => row.status === "changed").length }),
  check: async (dirNames) => {
    if (get().checking) return;
    set({ checking: true });
    try {
      const names = dirNames ?? (await api.listSkills()).map((meta) => meta.dirName);
      if (!names.length) {
        set({ count: 0, lastCheckedAt: new Date().toISOString() });
        return;
      }
      const result = await api.checkUpstreamBatch(names);
      set({
        count: result.filter((item) => item.ok && item.report?.changed).length,
        lastCheckedAt: new Date().toISOString(),
      });
    } catch {
      // 后台静默：没网、没装 git 都不该跳提示，等下一轮
    } finally {
      set({ checking: false });
    }
  },
  start: () => {
    if (pollTimer) return;
    firstTimer = setTimeout(() => void get().check(), FIRST_DELAY_MS);
    pollTimer = setInterval(() => void get().check(), INTERVAL_MS);
  },
  stop: () => {
    if (firstTimer) clearTimeout(firstTimer);
    if (pollTimer) clearInterval(pollTimer);
    firstTimer = null;
    pollTimer = null;
  },
}));
