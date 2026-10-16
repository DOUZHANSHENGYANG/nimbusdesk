import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { useEffect, useState } from "react";
import { tauriJsonStorage } from "@/lib/storage";
import {
  subtreeIds,
  todayStr,
  withDoneLastTree,
  type PlanTask,
  type PlanTaskPatch,
} from "@/features/plans/types";
import {
  applySnapshot,
  emptyHistory,
  popRedo,
  popUndo,
  pushBefore,
  type HistoryState,
} from "@/features/plans/history";

/* ── 完成后自动处理（A3） ───────────────────────────────
   settings 与 plans 是两个 store，互相 import 会成环，
   所以这里留一个由 settings 侧注入的读取器。
   默认值刻意是「置底开、清除关」：置底只影响显示、随时可逆；
   自动清除会真删数据，绝不该默认替用户做。 */

export interface CompletionPolicy {
  /** 勾选完成后立即从列表移除 */
  autoClear: boolean;
  /** 勾选完成后沉到底部 */
  autoSortDone: boolean;
}

let readCompletionPolicy: () => CompletionPolicy = () => ({
  autoClear: false,
  autoSortDone: true,
});

/** 由 settings store 注入（见 stores/settings.ts） */
export function setCompletionPolicyReader(fn: () => CompletionPolicy) {
  readCompletionPolicy = fn;
}

/* ── 迁移 ─────────────────────────────────────────────── */

/**
 * v1 是 `time: "HH:mm"` + `status: todo|doing|done`；
 * v2 是 `start`/`end` 区间 + `done` 布尔；
 * v3 加上 `updatedAt`（备份合并要用「同 id 比时间新者胜」）；
 * v4 起 `link` 为可选字段 —— 旧数据缺这个键即「未关联」，无需改写。
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
  /**
   * 撤销/重做栈。内存态，不持久化（见 persist 的 partialize）。
   * 放在 store 里而不是模块级单例：组件能用选择器订阅它，
   * 撤销按钮的可用状态会自己更新，不需要额外的订阅样板。
   */
  history: HistoryState;

  addTask: (date: string, parentId: string | null, title: string) => void;
  /**
   * 一次添加多条（多行粘贴拆分用）。
   *
   * 为什么不是循环调 addTask：那样会产生 N 次 store 更新 → N 次重渲染 →
   * N 条历史记录，撤销要按 10 次才能退回粘贴前。这里合成一次更新、一条历史。
   * 返回真正落库的 id，供调用方做后续定位（如滚动到新条目）。
   */
  addTasks: (date: string, parentId: string | null, titles: string[]) => string[];
  updateTask: (date: string, id: string, patch: PlanTaskPatch) => void;
  /** 勾选/取消完成（唯一由用户直接设置的状态） */
  toggleDone: (date: string, id: string) => void;
  removeTask: (date: string, id: string) => void;
  /** 归档整日（返回该日任务，供写入归档库）；无该日返回 null */
  takeDay: (date: string) => PlanTask[] | null;
  /** 把某日全部已完成任务删掉，返回删除条数 */
  clearDone: (date: string) => number;
  /** 按「完成沉底」重排某日 */
  sortDoneToBottom: (date: string) => void;
  /** 撤销：回填最近一次快照。无历史返回 false */
  undo: () => boolean;
  /** 重做 */
  redo: () => boolean;
}

/*
 * 历史栈标签存 **i18n key** 而不是已翻译字符串。
 * store 不该依赖 i18n 实例：语言在运行时可切换，而字符串一旦存进历史快照，
 * 切语言后旧记录会留在上一个语言里 —— 显示时翻译才是正确的时机。
 */
export const HISTORY_LABEL = {
  add: "plans.undo.add",
  addMany: "plans.undo.addMany",
  update: "plans.undo.update",
  remove: "plans.undo.remove",
  clearDone: "plans.undo.clearDone",
  sortDone: "plans.undo.sortDone",
  archive: "plans.undo.archive",
  restore: "plans.undo.restore",
} as const;

/**
 * 勾选完成后套用设置的自动行为。
 *
 * 顺序很重要：先置底再清除没有意义（清掉的行不需要重排），
 * 但先清除则可能把「被清除后剩下哪些」算错 —— 所以清除优先且短路。
 */
function applyCompletionPolicy(
  date: string,
  get: () => PlansState,
  set: (fn: (s: PlansState) => Partial<PlansState>) => void,
  id: string,
) {
  const { autoClear, autoSortDone } = readCompletionPolicy();
  if (autoClear) {
    // 只删这一个（用户刚勾的那个），不是「清空所有已完成」——
    // 那会把之前已完成但用户还想看的历史一并抹掉
    set((s) => {
      const tasks = s.days[date];
      if (!tasks) return s;
      const kill = subtreeIds(tasks, id);
      return { days: { ...s.days, [date]: tasks.filter((t) => !kill.has(t.id)) } };
    });
    return;
  }
  if (autoSortDone) get().sortDoneToBottom(date);
}

export const usePlans = create<PlansState>()(
  persist(
    (set, get) => ({
      days: {},
      history: emptyHistory,

      addTask: (date, parentId, title) => {
        const t = title.trim();
        if (!t) return;
        set((s) => ({
          history: pushBefore(s.history, s.days, [date], HISTORY_LABEL.add),
          days: {
            ...s.days,
            [date]: [
              ...(s.days[date] ?? []),
              {
                id: crypto.randomUUID(),
                parentId,
                title: t,
                done: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            ],
          },
        }));
      },

      addTasks: (date, parentId, titles) => {
        const clean = titles.map((x) => x.trim()).filter(Boolean);
        if (!clean.length) return [];
        const now = Date.now();
        // 同一次粘贴里每条 createdAt 递增 1ms，保持「粘贴顺序 = 显示顺序」
        // （全部用同一个时间戳时，任何按创建时间排序的实现都会给出随机顺序）
        const created: PlanTask[] = clean.map((title, i) => ({
          id: crypto.randomUUID(),
          parentId,
          title,
          done: false,
          createdAt: now + i,
          updatedAt: now + i,
        }));
        set((s) => ({
          history: pushBefore(s.history, s.days, [date], HISTORY_LABEL.addMany),
          days: { ...s.days, [date]: [...(s.days[date] ?? []), ...created] },
        }));
        return created.map((c) => c.id);
      },

      updateTask: (date, id, patch) =>
        set((s) => {
          const tasks = s.days[date];
          if (!tasks) return s;
          return {
            history: pushBefore(s.history, s.days, [date], HISTORY_LABEL.update),
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
        // 勾选完成后按设置自动沉底 / 清除。放在 toggle 之内而不是 UI 层，
        // 这样大纲、看板、纸片窗口三处勾选的行为完全一致。
        if (!t.done) applyCompletionPolicy(date, get, set, id);
      },

      removeTask: (date, id) =>
        set((s) => {
          const tasks = s.days[date];
          if (!tasks) return s;
          const kill = subtreeIds(tasks, id);
          return {
            history: pushBefore(s.history, s.days, [date], HISTORY_LABEL.remove),
            days: { ...s.days, [date]: tasks.filter((t) => !kill.has(t.id)) },
          };
        }),

      takeDay: (date) => {
        const tasks = get().days[date];
        if (!tasks) return null;
        set((s) => ({
          history: pushBefore(s.history, s.days, [date], HISTORY_LABEL.archive),
          days: Object.fromEntries(Object.entries(s.days).filter(([d]) => d !== date)),
        }));
        return tasks;
      },

      clearDone: (date) => {
        const tasks = get().days[date] ?? [];
        const kept = tasks.filter((t) => !t.done);
        const removed = tasks.length - kept.length;
        if (!removed) return 0;
        set((s) => ({
          history: pushBefore(s.history, s.days, [date], HISTORY_LABEL.clearDone),
          days: { ...s.days, [date]: kept },
        }));
        return removed;
      },

      sortDoneToBottom: (date) => {
        const tasks = get().days[date];
        if (!tasks || tasks.length < 2) return;
        const sorted = withDoneLastTree(tasks);
        // 顺序没变就不写。否则每次勾选都可能产生一条「无变化」的历史，
        // 撤销栈被噪声塞满，用户按撤销时看不出任何反应。
        if (sorted.every((t, i) => t.id === tasks[i]?.id)) return;
        set((s) => ({
          history: pushBefore(s.history, s.days, [date], HISTORY_LABEL.sortDone),
          days: { ...s.days, [date]: sorted },
        }));
      },

      undo: () => {
        const cur = get();
        const popped = popUndo(cur.history, cur.days);
        if (!popped) return false;
        set((s) => ({
          days: applySnapshot(s.days, popped.snapshot),
          history: popped.next,
        }));
        return true;
      },

      redo: () => {
        const cur = get();
        const popped = popRedo(cur.history, cur.days);
        if (!popped) return false;
        set((s) => ({
          days: applySnapshot(s.days, popped.snapshot),
          history: popped.next,
        }));
        return true;
      },
    }),
    {
      name: "plans",
      storage: createJSONStorage(() => tauriJsonStorage),
      version: 4,
      /*
       * 只持久化 days。
       * history 是内存态的运行历史 —— 持久化它会让「关掉应用再打开，
       * 还能撤销上一秒的操作」，这既没有意义（用户已经离开了那个上下文），
       * 又会让 plans.json 膨胀到几十倍（100 份快照）。
       */
      partialize: (s) => ({ days: s.days }) as PlansState,
      /**
       * 迁移链逐版本推进：v1 的 `time`/`status` → v2 的 `start`/`end`/`done`
       * → v3 补 `updatedAt`。v4 只是启用了可选的 `link`，无需改写步骤。
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
  // 恢复也是可撤销的一步：走 set 而不是直接写 days，
  // 这样 Ctrl+Z 能把「恢复」退回去
  usePlans.setState((s) => ({
    history: pushBefore(s.history, s.days, [date], HISTORY_LABEL.restore),
    days: { ...s.days, [date]: tasks },
  }));
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
