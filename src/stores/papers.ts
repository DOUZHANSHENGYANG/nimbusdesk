import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage, onStorageSynced } from "@/lib/storage";
import type { CapsuleEdge, PaperForm } from "@/features/plans/capsule";

/**
 * 桌面「待办纸片」窗口。
 *
 * 与文件栅栏（useFences）是同构的设计：
 *   - 每张纸片 = 一个独立的透明无边框窗口，常驻桌面
 *   - 几何（位置/尺寸/收起态/置顶）按 id 持久化
 *
 * 为什么单独一个 store 而不是塞进 useFences：
 *   纸片的键是**日期**（每天一张），栅栏的键是**分类 id**。两者的键空间无关，
 *   混在一个 map 里一旦出现同名键就会互相覆盖（用户完全可以把分类命名为
 *   "2026-03-10"）。分开存还能让「清空所有纸片」不影响文件栅栏。
 */

export interface PaperState {
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * 是否在桌面上「开着」。
   *
   * 与栅栏的 FenceState.open 同义：记录用户的意图，用于重启后自动恢复。
   * 不用「窗口是否存在」来判断 —— 那个状态在应用启动前不存在，
   * 于是每次重启纸片都会消失，用户得重新点一次（这和文件栅栏的行为也不一致）。
   */
  open?: boolean;
  /** 收起为窄条（只留标题 + 前几条） */
  collapsed?: boolean;
  /** 置顶（覆盖 always-on-bottom） */
  pinned?: boolean;
  /**
   * 形态。缺省 = "paper"。
   *
   * 刻意不复用 collapsed：collapsed 是「就地压矮」（窗口还在原位置，
   * 高度收到 116px，只留标题 + 前三条），胶囊是「挪到屏幕边缘只露一条」。
   * 两者叠加也讲得通：胶囊态里点开卡片再展开，先回到正常纸片。
   */
  form?: PaperForm;
  /** 胶囊吸附的屏幕边（缺省右） */
  edge?: CapsuleEdge;
  /** 胶囊沿边位置：相对**工作区顶**的逻辑像素（不是屏幕绝对坐标，换显示器才不会漂） */
  edgeY?: number;
}

interface PapersStoreState {
  papers: Record<string, PaperState>;
  /** 打开顺序（最近打开的排后面，用于纸片层叠时的层级） */
  order: string[];
  setGeometry: (date: string, geo: Partial<PaperState>) => void;
  setCollapsed: (date: string, collapsed: boolean) => void;
  setOpen: (date: string, open: boolean) => void;
  setPinned: (date: string, pinned: boolean) => void;
  setForm: (date: string, form: PaperForm) => void;
  setEdge: (date: string, edge: CapsuleEdge) => void;
  setEdgeY: (date: string, edgeY: number) => void;
  /** 记录一次打开（用于 order） */
  touch: (date: string) => void;
  /** 移除此纸片的几何记录（关窗时可选调用） */
  forget: (date: string) => void;
}

/*
 * 默认几何：竖长条，放在屏幕左上偏下一点。
 * 宽 260 是「一行任务标题不折行」的实测下限（13px 正文 + 复选框 + 内边距）；
 * 高 360 能放约 10 条，再多就滚动 —— 待办纸片该是「一眼看完今天」，
 * 不是第二个全屏列表。
 *
 * 每张新纸片向右下错开，避免完全重叠（用户开第二张时看不出开了新的）。
 */
export const DEFAULT_PAPER: PaperState = { x: 200, y: 180, w: 260, h: 360 };

const CASCADE = 28;

export const usePapers = create<PapersStoreState>()(
  persist(
    (set) => ({
      papers: {},
      order: [],

      setGeometry: (date, geo) =>
        set((s) => ({
          papers: {
            ...s.papers,
            [date]: { ...(s.papers[date] ?? DEFAULT_PAPER), ...geo },
          },
        })),

      setCollapsed: (date, collapsed) =>
        set((s) => ({
          papers: {
            ...s.papers,
            [date]: { ...(s.papers[date] ?? DEFAULT_PAPER), collapsed },
          },
        })),

      setOpen: (date, open) =>
        set((s) => ({
          papers: {
            ...s.papers,
            [date]: { ...(s.papers[date] ?? DEFAULT_PAPER), open },
          },
          // 打开时记进 order（用于层叠与「已打开」标记），关闭时移除
          order: open
            ? [...s.order.filter((d) => d !== date), date]
            : s.order.filter((d) => d !== date),
        })),

      setPinned: (date, pinned) =>
        set((s) => ({
          papers: {
            ...s.papers,
            [date]: { ...(s.papers[date] ?? DEFAULT_PAPER), pinned },
          },
        })),

      setForm: (date, form) =>
        set((s) => ({
          papers: {
            ...s.papers,
            [date]: { ...(s.papers[date] ?? DEFAULT_PAPER), form },
          },
        })),

      setEdge: (date, edge) =>
        set((s) => ({
          papers: {
            ...s.papers,
            [date]: { ...(s.papers[date] ?? DEFAULT_PAPER), edge },
          },
        })),

      setEdgeY: (date, edgeY) =>
        set((s) => ({
          papers: {
            ...s.papers,
            [date]: { ...(s.papers[date] ?? DEFAULT_PAPER), edgeY },
          },
        })),

      touch: (date) =>
        set((s) => ({
          order: [...s.order.filter((d) => d !== date), date],
        })),

      forget: (date) =>
        set((s) => {
          const next = { ...s.papers };
          delete next[date];
          return { papers: next, order: s.order.filter((d) => d !== date) };
        }),
    }),
    {
      name: "todo-papers",
      storage: createJSONStorage(() => tauriJsonStorage),
      /*
       * 刻意**不**升 version。新字段全部可选，老记录读进来照样合法；
       * 而版本号 +1 却又不给 migrate 的话，zustand 会直接丢弃磁盘上的旧记录，
       * 用户所有纸片的位置尺寸会被一次静默清空。
       */
      version: 1,
    },
  ),
);

/**
 * 取某日纸片的几何，缺失时按已开数量错开排布。
 *
 * 不能直接用 DEFAULT_PAPER：那样连开 3 天会得到 3 张完全重叠的纸片，
 * 用户拖动其中一张后另外两张还在下面，看起来像「关了又开没生效」。
 * 错开量按**已持久化的纸片数**算，所以重启后位置仍然稳定。
 */
export function paperGeometryFor(date: string): PaperState {
  const s = usePapers.getState();
  return (
    s.papers[date] ?? {
      ...DEFAULT_PAPER,
      x: DEFAULT_PAPER.x + CASCADE * (Object.keys(s.papers).length % 6),
      y: DEFAULT_PAPER.y + CASCADE * (Object.keys(s.papers).length % 6),
    }
  );
}

onStorageSynced((key, value) => {
  if (key !== "todo-papers" || !value || typeof value !== "object") return;
  const state = (value as { state?: Partial<PapersStoreState> }).state;
  if (state?.papers && Array.isArray(state.order)) usePapers.setState({ papers: state.papers, order: state.order });
});
