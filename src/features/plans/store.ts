import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { useEffect, useState } from "react";
import { tauriJsonStorage } from "@/lib/storage";
import {
  subtreeIds,
  todayStr,
  type PlanTask,
  type PlanTaskPatch,
} from "@/features/plans/types";

/* ── 迁移 ─────────────────────────────────────────────── */

/**
 * v1 是 `time: "HH:mm"` + `status: todo|doing|done`；
 * v2 是 `start`/`end` 区间 + `done` 布尔；
 * v3 加上 `updatedAt`（备份合并要用「同 id 比时间新者胜」）。
 *
 * v1 没有区间概念，把 time 当作起点、结束补 1 小时，
 * 这样老任务在时间轴上仍有可见跨度，而不是塌成一个点。
 */
function migrateTaskV1(t: Partial<PlanTask> & { time?: string; status?: string }): PlanTask {
  const start = t.start ?? t.time;
  const { time: _time, status: _status, ...rest } = t;
  let end = t.end;
  if (!end && start) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(start);
    if (m) {
      // 23:xx + 1h 会跨天，截到 23:59（区间不跨日）
      const total = Math.min(Number(m[1]) * 60 + Number(m[2]) + 60, 23 * 60 + 59);
      const hh = String(Math.floor(total / 60)).padStart(2, "0");
      const mm = String(total % 60).padStart(2, "0");
      end = `${hh}:${mm}`;
    }
  }
  return { ...(rest as PlanTask), start, end, done: t.done ?? _status === "done" };
}

/**
 * 补齐 `updatedAt`。旧数据没有这个概念，用 `createdAt` 兜底 ——
 * 用 `Date.now()` 会让所有历史任务在同一次启动里「同时变新」，
 * 之后任何一次恢复都会把备份里的历史版本全部判成旧的。
 */
function fillUpdatedAt(t: PlanTask): PlanTask {
  return t.updatedAt ? t : { ...t, updatedAt: t.createdAt ?? Date.now() };
}

/** 逐日补齐 updatedAt（迁移用；旧字段缺失时保持原样） */
function migrateDaysV3(days: Record<string, PlanTask[]>): Record<string, PlanTask[]> {
  const out: Record<string, PlanTask[]> = {};
  for (const [date, list] of Object.entries(days)) out[date] = list.map(fillUpdatedAt);
  return out;
}

/* ── 活跃计划：plans.json ─────────────────────────────── */

interface PlansState {
  days: Record<string, PlanTask[]>;
  addTask: (date: string, parentId: string | null, title: string) => void;
  updateTask: (date: string, id: string, patch: PlanTaskPatch) => void;
  /** 勾选/取消完成（唯一由用户直接设置的状态） */
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
            done: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
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
              [date]: tasks.map((t) =>
                t.id === id ? { ...t, ...patch, updatedAt: Date.now() } : t,
              ),
            },
          };
        }),

      toggleDone: (date, id) => {
        const t = (get().days[date] ?? []).find((x) => x.id === id);
        if (!t) return;
        get().updateTask(date, id, { done: !t.done });
      },

      removeTask: (date, id) =>
        set((s) => {
          const tasks = s.days[date];
          if (!tasks) return s;
          const kill = subtreeIds(tasks, id);
          return { days: { ...s.days, [date]: tasks.filter((t) => !kill.has(t.id)) } };
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
    {
      name: "plans",
      storage: createJSONStorage(() => tauriJsonStorage),
      version: 3,
      /**
       * 迁移链逐版本推进：v1 的 `time`/`status` → v2 的 `start`/`end`/`done`
       * → v3 补 `updatedAt`。写成链而不是「一步到位」，
       * 才能让 v1 和 v2 的数据都走到同一个终态。
       */
      migrate: (persisted, version) => {
        const state = persisted as { days?: Record<string, unknown[]> } | undefined;
        if (!state?.days) return persisted as PlansState;
        let days = state.days as Record<string, PlanTask[]>;
        if (version < 2) {
          const next: Record<string, PlanTask[]> = {};
          for (const [date, list] of Object.entries(days)) {
            next[date] = (list as (Partial<PlanTask> & { time?: string; status?: string })[]).map(
              migrateTaskV1,
            );
          }
          days = next;
        }
        if (version < 3) days = migrateDaysV3(days);
        return { days } as PlansState;
      },
    },
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
    {
      name: "plans-archive",
      storage: createJSONStorage(() => tauriJsonStorage),
      version: 3,
      // 归档库的迁移规则与活跃库一致（v1 区间化 → v2 补 updatedAt）
      migrate: (persisted, version) => {
        const state = persisted as
          | { days?: Record<string, { archivedAt: number; tasks: unknown[] }> }
          | undefined;
        if (!state?.days) return persisted as ArchiveState;
        const days: ArchiveState["days"] = {};
        for (const [date, entry] of Object.entries(state.days)) {
          const tasks =
            version < 2
              ? (
                  entry.tasks as (Partial<PlanTask> & { time?: string; status?: string })[]
                ).map(migrateTaskV1)
              : (entry.tasks as PlanTask[]);
          days[date] = {
            archivedAt: entry.archivedAt,
            tasks: version < 3 ? tasks.map(fillUpdatedAt) : tasks,
          };
        }
        return { days } as ArchiveState;
      },
    },
  ),
);

const EMPTY_TASKS: PlanTask[] = [];

/** 某日任务（稳定快照：缺失日返回模块级空数组，避免 useSyncExternalStore 不稳定快照） */
export function useDayTasks(date: string): PlanTask[] {
  return usePlans((s) => s.days[date] ?? EMPTY_TASKS);
}

/* ── 时间推进 ─────────────────────────────────────────── */

/**
 * 定期重算当前时刻，驱动「进行中」自动出现/消失。
 *
 * 对齐到下一个整分钟触发：这样 09:00 一到就立刻亮起，
 * 而不是等固定轮询恰好撞上（最坏会晚近一分钟）。
 */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer: number;
    const schedule = () => {
      const d = new Date();
      const toNextMinute = 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds());
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, Math.max(toNextMinute, 1000));
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);

  return now;
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
