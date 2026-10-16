import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";

/**
 * 任务提醒设置。
 *
 * 为什么不做 Rust 侧后台定时器：应用关闭后仍要提醒，就得让进程常驻托盘、
 * 由 Rust 持有调度 —— 那会改变「关窗 = 退出」的语义（用户明确暂缓开机自启），
 * 且需要另一套任务数据通道。当前接受「应用运行时提醒」这个边界。
 *
 * 因此提醒是**前端自调度**：`useReminderLoop()` 每分钟检查一次，
 * 只检查今天与明天（跨越午夜的任务不会漏）。
 */

export interface ReminderSettings {
  enabled: boolean;
  /** 提前量（分钟）。0 = 在 start 时刻提醒 */
  advance: number;
  /** 已通知过的实例键（`<date>:<taskId>:<start>`），去重 */
  notified: string[];
  setEnabled: (v: boolean) => void;
  setAdvance: (v: number) => void;
  markNotified: (key: string) => void;
  clearNotified: () => void;
}

/** 去重集合上限。键含日期，长期只增不减会无限膨胀 */
const MAX_NOTIFIED = 500;

export const useReminderSettings = create<ReminderSettings>()(
  persist(
    (set) => ({
      enabled: false,
      advance: 0,
      notified: [],

      setEnabled: (enabled) => set({ enabled }),
      setAdvance: (advance) => set({ advance: Math.max(0, Math.round(advance)) }),

      markNotified: (key) =>
        set((s) => {
          if (s.notified.includes(key)) return s;
          const next = [...s.notified, key];
          // 超出上限时丢最旧的：保留的是「最近通知过」的
          return { notified: next.length > MAX_NOTIFIED ? next.slice(-MAX_NOTIFIED) : next };
        }),

      clearNotified: () => set({ notified: [] }),
    }),
    {
      name: "reminders",
      storage: createJSONStorage(() => tauriJsonStorage),
      version: 1,
    },
  ),
);
