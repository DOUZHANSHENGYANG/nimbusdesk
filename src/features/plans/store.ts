import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";
import {
  subtreeIds,
  todayStr,
  type PlanTask,
  type PlanTaskPatch,
} from "@/features/plans/types";

/* ── 活跃计划：plans.json ─────────────────────────────── */

interface PlansState {
  days: Record<string, PlanTask[]>;
  addTask: (date: string, parentId: string | null, title: string) => void;
  updateTask: (date: string, id: string, patch: PlanTaskPatch) => void;
  setStatus: (date: string, id: string, status: PlanTask["status"]) => void;
  toggleDone: (date: string, id: string) => void;
  removeTask: (date: string, id: string) => void;
  /** 归档整日（返回该日任务，供写入归档库）；无该日返回 null */
  takeDay: (date: string) => PlanTask[] | null;
}

export const usePlans = create<PlansState>()(
  persist(
    (set, get) => ({
      days: {},

      addTask: (date, parentId, title) =>
        set((s) => {
          const tasks = s.days[date] ?? [];
          const task: PlanTask = {
            id: crypto.randomUUID(),
            parentId,
            title,
            status: "todo",
            createdAt: Date.now(),
          };
          return { days: { ...s.days, [date]: [...tasks, task] } };
        }),

      updateTask: (date, id, patch) =>
        set((s) => {
          const tasks = s.days[date];
          if (!tasks) return s;
          return {
            days: {
              ...s.days,
              [date]: tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
            },
          };
        }),

      setStatus: (date, id, status) => get().updateTask(date, id, { status }),

      toggleDone: (date, id) => {
        const t = (get().days[date] ?? []).find((x) => x.id === id);
        if (!t) return;
        get().setStatus(date, id, t.status === "done" ? "todo" : "done");
      },

      removeTask: (date, id) =>
        set((s) => {
          const tasks = s.days[date];
          if (!tasks) return s;
          const kill = subtreeIds(tasks, id);
          const next = tasks.filter((t) => !kill.has(t.id));
          return { days: { ...s.days, [date]: next } };
        }),

      takeDay: (date) => {
        const tasks = get().days[date];
        if (!tasks) return null;
        set((s) => {
          const next = { ...s.days };
          delete next[date];
          return { days: next };
        });
        return tasks;
      },
    }),
    { name: "plans", storage: createJSONStorage(() => tauriJsonStorage), version: 1 },
  ),
);

/* ── 历史归档：plans-archive.json ─────────────────────── */

interface ArchiveState {
  days: Record<string, { archivedAt: number; tasks: PlanTask[] }>;
  putDay: (date: string, tasks: PlanTask[]) => void;
  takeDay: (date: string) => PlanTask[] | null;
}

export const usePlansArchive = create<ArchiveState>()(
  persist(
    (set, get) => ({
      days: {},

      putDay: (date, tasks) =>
        set((s) => ({
          days: { ...s.days, [date]: { archivedAt: Date.now(), tasks } },
        })),

      takeDay: (date) => {
        const entry = get().days[date];
        if (!entry) return null;
        set((s) => {
          const next = { ...s.days };
          delete next[date];
          return { days: next };
        });
        return entry.tasks;
      },
    }),
    { name: "plans-archive", storage: createJSONStorage(() => tauriJsonStorage), version: 1 },
  ),
);

const EMPTY_TASKS: PlanTask[] = [];

/** 某日任务（稳定快照：缺失日返回模块级空数组，避免 useSyncExternalStore 不稳定快照） */
export function useDayTasks(date: string): PlanTask[] {
  return usePlans((s) => s.days[date] ?? EMPTY_TASKS);
}

/* ── 跨库动作 ─────────────────────────────────────────── */

/** 归档某日（活跃 → 归档库） */
export function archiveDay(date: string): boolean {
  const tasks = usePlans.getState().takeDay(date);
  if (!tasks) return false;
  usePlansArchive.getState().putDay(date, tasks);
  return true;
}

/** 恢复某日（归档库 → 活跃） */
export function restoreDay(date: string): boolean {
  const tasks = usePlansArchive.getState().takeDay(date);
  if (!tasks) return false;
  usePlans.setState((s) => ({ days: { ...s.days, [date]: tasks } }));
  return true;
}

/** 启动时自动归档过期日（date < today） */
export function autoArchivePastDays(): number {
  const today = todayStr();
  let n = 0;
  for (const date of Object.keys(usePlans.getState().days)) {
    if (date < today) {
      if (archiveDay(date)) n++;
    }
  }
  return n;
}
