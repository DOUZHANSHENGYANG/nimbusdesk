/**
 * 文件操作历史（撤销栈）。
 *
 * 参考 Pogget 的 `CoreFileOp`：记录**够用来反向执行**的最小信息，而不是整个文件快照。
 * `path3` 那种「被覆盖的原目标」在这里用 `to` 承载；批操作用 `groupId` 归并。
 *
 * 诚实的边界：删除走的是系统回收站，撤销它需要 shell 的还原接口 —— 这里**不假装能撤销**，
 * 只把操作记进历史并在 UI 上说清「去回收站还原」。重命名与移动是真的可逆，优先支持。
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";

export type HistoryKind = "create" | "rename" | "move" | "delete" | "rebox";

export interface HistoryOp {
  id: string;
  kind: HistoryKind;
  /** 发生时刻 */
  at: number;
  /** 归并同一批操作（一次拖入多个文件） */
  groupId?: string;
  /** 关联的条目 id，撤销时用来同步 store（可能未知） */
  itemId?: string;
  /** rename: 原路径；move: 原路径；create/delete: 被操作的路径；rebox: 原分类 id */
  from: string;
  /** rename/move: 新路径；rebox: 新分类 id */
  to?: string;
  /** 给人看的一行说明 */
  label: string;
}

/** 栈上限：够撤回到「刚才那几步」，又不至于让数据文件无限长 */
export const HISTORY_LIMIT = 50;

/** 哪些操作真的能撤销。删除不走这里（见文件头注释）。 */
export function isUndoable(op: HistoryOp): boolean {
  return op.kind === "rename" || op.kind === "move" || op.kind === "create" || op.kind === "rebox";
}

/** 压栈并裁剪到上限；返回新数组（纯函数，便于单测） */
export function pushOp(stack: HistoryOp[], op: HistoryOp, limit = HISTORY_LIMIT): HistoryOp[] {
  return [op, ...stack].slice(0, Math.max(1, limit));
}

/** 栈顶可撤销的那一条（跳过不可撤销的删除记录） */
export function nextUndoable(stack: HistoryOp[]): HistoryOp | undefined {
  return stack.find(isUndoable);
}

interface HistoryState {
  stack: HistoryOp[];
  push: (op: Omit<HistoryOp, "id" | "at"> & { at?: number }) => void;
  /** 撤销成功后把这条移出栈（同 groupId 的一起移除） */
  drop: (id: string) => void;
  clear: () => void;
}

export const useFileHistory = create<HistoryState>()(
  persist(
    (set) => ({
      stack: [],
      push: (op) => set((s) => {
        const entry: HistoryOp = {
          ...op,
          id: crypto.randomUUID(),
          at: op.at ?? Date.now(),
        };
        return { stack: pushOp(s.stack, entry) };
      }),
      drop: (id) => set((s) => {
        const target = s.stack.find((op) => op.id === id);
        const group = target?.groupId;
        return { stack: s.stack.filter((op) => op.id !== id && (!group || op.groupId !== group)) };
      }),
      clear: () => set({ stack: [] }),
    }),
    { name: "files-history", storage: createJSONStorage(() => tauriJsonStorage), version: 1 },
  ),
);
