import { childrenOf, type PlanTask } from "@/features/plans/types";

/**
 * 「贴边胶囊 + 悬停预览卡」的几何与手感。
 *
 * 交互原型来自 PaperTodo 的 EdgeCapsule / Edge Preview —— **只借鉴交互概念与数值**，
 * 未使用其任何代码（那是 C#/WPF，技术栈不通；且许可是 PolyForm Noncommercial，
 * 抄进来会污染整个项目）。数值取它已经调过的，观感能直接对齐，省掉自己试参数。
 *
 * ── 机制：同一个窗口两形态，不新开窗口 ──────────────────────
 * 窗口尺寸恒定 `CAPSULE_WIN_W × CAPSULE_WIN_H`（= 卡片宽 280 + 贴边条 14）。
 * 静止时把窗口推到工作区**外**，屏幕上只剩 14 宽的一条；
 * 悬停时窗口整体横移 280px，把卡片从屏幕边缘后面滑出来。
 *
 * 为什么只挪窗口、从不改尺寸：WebView2 下每帧改窗口尺寸会触发重排 + 同步重绘，必卡；
 * 挪窗口是纯定位。PaperTodo 为了同样的效果要上 DirectComposition，这里靠这个取巧绕开。
 *
 * ── 滑块为什么要在窗口内反向平移 ────────────────────────────
 * 窗口横移 280 会把滑块一起带走。所以滑块在窗口内反向平移同样的距离，
 * 于是它在**屏幕坐标上纹丝不动**（始终贴在边缘），观感就是「卡片从滑块后面抽出来」，
 * 而不是「整条东西一起跑」。
 *
 * ── 静止时窗口是穿透的 ──────────────────────────────────
 * 静止时那 14×340 其实是「透明但仍能接鼠标」的区域。为了让它不挡住底下的东西，
 * 未悬停时窗口设 ignoreCursorEvents（见 views/capsule.tsx），代价是收不到鼠标事件，
 * 悬停只能靠 `screenCursor()` 轮询全局光标位置来判断。
 */

/** 贴边胶囊吸附的屏幕边 */
export type CapsuleEdge = "left" | "right";

/** 纸片窗口的两种形态 */
export type PaperForm = "paper" | "capsule";

/* ── 手感常量（PaperTodo 已验证的数值）──────────────────── */

/** 贴边静止时露出的宽度（PaperTodo `CapsuleCloseWidth`） */
export const CAPSULE_SLIVER = 14;
/** 胶囊药丸高度（PaperTodo `CapsuleHeight`） */
export const CAPSULE_PILL_H = 46;
/** 药丸圆角（PaperTodo `CornerRadius`） */
export const CAPSULE_RADIUS = 12;
/** 预览卡宽（PaperTodo `TodoDefaultWidth`） */
export const CAPSULE_CARD_W = 280;
/** 预览卡高（PaperTodo `TodoDefaultHeight`） */
export const CAPSULE_CARD_H = 340;
/** 窗口尺寸：卡片 + 贴边那一条 */
export const CAPSULE_WIN_W = CAPSULE_CARD_W + CAPSULE_SLIVER;
export const CAPSULE_WIN_H = CAPSULE_CARD_H;
/** 第一个胶囊距工作区顶的距离（PaperTodo `StartTopMargin`） */
export const CAPSULE_TOP_START = 48;
/** 相邻胶囊的槽距 = 药丸高 + gap 4（PaperTodo `CapsuleHeight + DeepCapsuleGap`） */
export const CAPSULE_PITCH = CAPSULE_PILL_H + 4;
/** 滑出/收回时长（PaperTodo `HorizontalResizeMilliseconds`） */
export const CAPSULE_SLIDE_MS = 160;
/** 鼠标离开后多久收回（PaperTodo `PreviewExitPolicy.FixedWaitMilliseconds`） */
export const CAPSULE_EXIT_MS = 1000;
/**
 * 悬停意图：指针进入滑块后先等这么久才展开。
 *
 * PaperTodo 那套是 20 个采样点 / 64ms 窗口的「刹车检测」，判断你是路过还是想停；
 * 太重了。这里用固定 120ms 逼近同样的效果：鼠标沿屏幕边缘一路划过去时，
 * 每经过一个胶囊停留都不到 120ms，卡片就不会乱弹。
 */
export const CAPSULE_HOVER_MS = 120;
/** 未悬停时的全局光标轮询间隔（窗口穿透，收不到鼠标事件） */
export const CAPSULE_POLL_MS = 80;
/** 工作区四周留白：药丸不许贴到屏幕物理边，也避免和任务栏打架 */
export const CAPSULE_EDGE_MARGIN = 8;

/* ── 几何（全部纯函数，单位一律「逻辑像素 + 屏幕绝对坐标」）── */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 屏幕工作区（已扣掉任务栏/停靠栏） */
export interface WorkArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 把沿边位置夹进合法范围。
 *
 * 上界按**卡片高度**算而不是药丸高度：卡片是展开后才出现的，如果只保证药丸不越界，
 * 悬停一下卡片就会有一半探到任务栏上。工作区比卡片还矮时退化成只保药丸可见。
 */
export function clampEdgeY(wa: WorkArea, edgeY: number): number {
  const lo = CAPSULE_EDGE_MARGIN;
  const hi = Math.max(lo, wa.h - CAPSULE_CARD_H - CAPSULE_EDGE_MARGIN);
  return Math.round(Math.min(hi, Math.max(lo, edgeY)));
}

/** 新胶囊的缺省沿边位置（PaperTodo 的 StartTopMargin = 48） */
export function defaultEdgeY(wa: WorkArea): number {
  return clampEdgeY(wa, CAPSULE_TOP_START);
}

/** 第 index 个胶囊的缺省沿边位置：错开，否则多张胶囊会完全重叠 */
export function slotEdgeY(wa: WorkArea, index: number): number {
  return clampEdgeY(wa, CAPSULE_TOP_START + CAPSULE_PITCH * index);
}

/** 静止态（只露一条）时窗口的位置 */
export function capsuleRestRect(wa: WorkArea, edge: CapsuleEdge, edgeY: number): Rect {
  const y = wa.y + clampEdgeY(wa, edgeY);
  const x = edge === "right" ? wa.x + wa.w - CAPSULE_SLIVER : wa.x - CAPSULE_CARD_W;
  return { x, y, w: CAPSULE_WIN_W, h: CAPSULE_WIN_H };
}

/** 展开态（整张卡可见）时窗口的位置：从静止位置朝屏幕内横移一张卡 */
export function capsuleOpenRect(wa: WorkArea, edge: CapsuleEdge, edgeY: number): Rect {
  const rest = capsuleRestRect(wa, edge, edgeY);
  const x = edge === "right" ? rest.x - CAPSULE_CARD_W : rest.x + CAPSULE_CARD_W;
  return { ...rest, x };
}

/** 滑块在屏幕上的矩形：未悬停时的命中区（也是穿透时用来判断「光标进来了没」的区域） */
export function capsulePillScreenRect(wa: WorkArea, edge: CapsuleEdge, edgeY: number): Rect {
  const y = wa.y + clampEdgeY(wa, edgeY);
  const x = edge === "right" ? wa.x + wa.w - CAPSULE_SLIVER : wa.x;
  return { x, y, w: CAPSULE_SLIVER, h: CAPSULE_PILL_H };
}

/** 矩形命中判定。pad 用来把标题栏边缘的 1px 抖动也算命中，避免临界点上闪 */
export function rectContains(r: Rect, x: number, y: number, pad = 0): boolean {
  return x >= r.x - pad && x < r.x + r.w + pad && y >= r.y - pad && y < r.y + r.h + pad;
}

/**
 * 滑块在**窗口内**的横向偏移，由「实际落位的窗口 x」反推。
 *
 * 为什么不直接按进度算（`卡片宽 × 进度`）：窗口位置最终会被系统量化到物理像素，
 * 而偏移是连续值，两者的差会在滑动过程中累积成「滑块轻微抖动」——
 * 而「滑块在屏幕坐标上纹丝不动、卡片从它后面抽出来」正是这套观感成立的前提。
 * 反过来用 `药丸屏幕 x − 窗口 x` 推偏移，无论窗口被量化到哪一格，滑块都精确贴住边缘。
 */
export function pillInnerX(pillScreenX: number, windowX: number): number {
  return pillScreenX - windowX;
}

/** 窗口在某个滑出进度下的位置（只动 x，y 不变） */
export function capsuleRectAt(
  wa: WorkArea,
  edge: CapsuleEdge,
  edgeY: number,
  progress: number,
): Rect {
  const rest = capsuleRestRect(wa, edge, edgeY);
  const open = capsuleOpenRect(wa, edge, edgeY);
  return { ...rest, x: rest.x + (open.x - rest.x) * progress };
}

/** 沿边拖动：由光标屏幕 Y 反推 edgeY。grabOffset 是按下时指针相对药丸顶部的偏移 */
export function edgeYFromDrag(wa: WorkArea, pointerY: number, grabOffset: number): number {
  return clampEdgeY(wa, pointerY - wa.y - grabOffset);
}
/* ── 预览卡内容 ────────────────────────────────────── */

/**
 * 把任务树压平成「行 + 缩进层级」。
 *
 * 预览卡要一次看全（含子任务），而不是像桌面纸片那样只看根级。
 * 卡片存在的意义就是「不用展开纸片就能查清楚」，藏掉子任务就白做了。
 *
 * 用 childrenOf 而非直接按 parentId 分组：兄弟顺序要跟主应用一致，
 * 而数组里同一父下的相对次序就是用户看到的次序。
 */
export function flattenTree(
  tasks: PlanTask[],
  parentId: string | null = null,
  depth = 0,
): { task: PlanTask; depth: number }[] {
  const out: { task: PlanTask; depth: number }[] = [];
  for (const t of childrenOf(tasks, parentId)) {
    out.push({ task: t, depth });
    out.push(...flattenTree(tasks, t.id, depth + 1));
  }
  return out;
}
