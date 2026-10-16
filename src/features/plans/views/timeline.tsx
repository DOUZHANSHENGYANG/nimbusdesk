import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import {
  DAY_END_MIN,
  SNAP_MIN,
  axisRange,
  clampMinute,
  dragEdge,
  fmtMinutes,
  normalizeRange,
  packLanes,
  shiftRange,
  snapMinute,
  statusOf,
  todayStr,
  type PlanTask,
  type TaskStatus,
} from "@/features/plans/types";
import { useDayTasks, useNow, usePlans } from "@/features/plans/store";
import { StatusButton, doneTitleStyle } from "@/features/plans/views/shared";
import { cn } from "@/lib/utils";
import { capturePointer, releasePointer } from "@/lib/touch";

/**
 * 时间轴视图：08:00 起的纵向坐标轴 + 可拖拽时间块。
 *
 * 轴只覆盖 08:00–24:00（16 小时），因为一天里真正被安排的事情几乎都在这段，
 * 画满 00:00–24:00 会让轴高到放不下、还得滚动才能看全。
 *
 * 轴的上方（也就是「8 点之前」）就是未定时任务的放置区：
 * 没有时间的任务需要一个明确的位置，把它放在轴的起点之上，
 * 语义就是「还没排进今天」—— 同时也充当「把块拖出轴 = 清除时间」的落点。
 *
 * 交互（与栅栏、文件页的「单击选中 / 拖动移动」一致）：
 * - 拖块体 → 整体平移（保持时长）
 * - 拖块的上/下边缘 → 只动起点 / 只动终点（最短 15 分钟）
 * - 把未定时卡片拖到轴上 → 设定时间（默认 1 小时）
 * - 把轴上的块拖到轴上方 → 清除时间（块上也有 ✕ 按钮）
 * - ↑↓ 平移、Shift+↑↓ 改终点、Alt+↑↓ 改起点、按住 Ctrl 步长 1 分钟
 *
 * 拖动过程只更新本地预览，松手才写一次 store —— 避免每像素一次落盘与跨窗口广播。
 */

/**
 * 轴的默认起点：08:00。轴只画这段之后的时段 —— 一天里真正被安排的事情
 * 几乎都在 8 点后，画满 00:00–24:00 会让轴高到放不下。
 *
 * 但当天若有更早的任务（TimeRangePicker 允许设 07:00），轴会自动向上扩到
 * 那一小时，否则那些块会渲染在负偏移处、被容器裁掉，看不见也点不到。
 */
const AXIS_DEFAULT_FROM = 8 * 60;
/** 轴的终点：24:00。用 1440 而不是 1439 只是为了让刻度收尾整齐，从不写进任务 */
const AXIS_TO = 24 * 60;
/** 每小时像素高度。16 小时 × 44px ≈ 700px，一屏能放下 */
const PX_PER_HOUR = 44;
const PX_PER_MIN = PX_PER_HOUR / 60;
/** 左侧时间刻度栏宽度 */
const GUTTER = 56;
/** 上/下边缘拖拽热区高度上限 */
const EDGE_MAX = 7;
/** 拖入时新建块的默认时长（分钟） */
const ASSIGN_MIN = 60;
/** 块的最小可见高度 */
const MIN_BLOCK_PX = 18;

type Span = { start: number; end: number };
type DragMode = "move" | "start" | "end";

interface DragState {
  id: string;
  /** assign = 从未定时区拖入 */
  mode: DragMode | "assign";
  /** 按下时的区间，拖动全程以它为基准，避免误差累积 */
  origin: Span;
  /** 按下时指针所在的分钟数（未吸附），move 用它算位移以保留非整点偏移 */
  grab: number;
  /** 预览区间；null = 当前不在轴上 */
  next: Span | null;
  /** 预览为「松手即清除时间」 */
  clearing: boolean;
}

const STATUS_BOX: Record<TaskStatus, string> = {
  todo: "border-border bg-card hover:border-brand/50",
  doing: "border-brand/60 bg-brand/10",
  done: "border-border bg-muted/40",
};

const STATUS_STRIPE: Record<TaskStatus, string> = {
  todo: "bg-muted-foreground/30",
  doing: "bg-brand",
  done: "bg-success/50",
};

export function TimelineView({ date }: { date: string }) {
  const { t } = useTranslation();
  const tasks = useDayTasks(date);
  const now = useNow();
  const updateTask = usePlans((s) => s.updateTask);
  const toggleDone = usePlans((s) => s.toggleDone);

  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const shelfRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  /** 有时间 → 块；没时间 → 未定时区（轴上方） */
  const { timed, untimed } = useMemo(() => {
    const timed: { task: PlanTask; span: Span }[] = [];
    const untimed: PlanTask[] = [];
    for (const task of tasks) {
      const span = axisRange(task);
      if (span) timed.push({ task, span });
      else untimed.push(task);
    }
    return { timed, untimed };
  }, [tasks]);
  const lanes = useMemo(
    () =>
      packLanes(timed.map(({ task, span }) => ({ id: task.id, start: span.start, end: span.end }))),
    [timed],
  );

  /**
   * 轴起点：默认 08:00，当天有更早的任务就向上扩到那一小时。
   *
   * 向上扩是必要的：时间选择器允许设 07:00，若轴固定从 08:00 开始，
   * 那种块会渲染在负偏移处、被容器裁掉 —— 看不见也点不到。
   */
  const axisFrom = useMemo(() => {
    const earliest = timed.reduce<number | null>(
      (min, { span }) => (min == null || span.start < min ? span.start : min),
      null,
    );
    if (earliest == null) return AXIS_DEFAULT_FROM;
    return Math.min(AXIS_DEFAULT_FROM, Math.floor(earliest / 60) * 60);
  }, [timed]);

  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let m = axisFrom; m <= AXIS_TO; m += 60) out.push(m);
    return out;
  }, [axisFrom]);
  const height = ((AXIS_TO - axisFrom) / 60) * PX_PER_HOUR;

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const showNow = date === todayStr() && nowMin >= axisFrom && nowMin <= AXIS_TO;

  const dragging = drag != null;
  const active = drag?.next ?? null;
  const assigning = drag?.mode === "assign" && active != null;

  /**
   * 进入视图 / 换日期时滚到当天最早任务处。
   *
   * 用「已定位过的日期」做门控：同一日期只自动定位一次。
   * 若跟着 tasks 引用跑，拖动落盘会让视口在拖动中跳走（块随之在光标下漂移）。
   */
  const scrolledForDateRef = useRef<string | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (scrolledForDateRef.current === date) return;
    scrolledForDateRef.current = date;
    const first = timed.reduce<number | null>(
      (min, { span }) => (min == null || span.start < min ? span.start : min),
      null,
    );
    el.scrollTop = Math.max((first ?? axisFrom) - axisFrom - 30, 0) * PX_PER_MIN;
  }, [date, timed]);

  /* ── 坐标换算 ──────────────────────────────────────── */

  /**
   * 指针所在的分钟数（未吸附）。
   *
   * 用 getBoundingClientRect()：它给的是元素当前视口位置，滚动时 top 会跟着变，
   * 于是 (clientY - top) 自动补偿了滚动量 —— 拖动中滚轮滚动也不会算错。
   */
  const rawMinuteAt = (clientY: number): number => {
    const el = trackRef.current;
    if (!el) return axisFrom;
    return axisFrom + (clientY - el.getBoundingClientRect().top) / PX_PER_MIN;
  };

  /** 指针所在的分钟数（吸附到 SNAP_MIN，夹在轴上范围内） */
  const minuteAt = (clientY: number): number =>
    clampMinute(snapMinute(rawMinuteAt(clientY)), axisFrom, DAY_END_MIN);

  /**
   * 指针是否在轴的上方 —— 也就是「8 点之前」那块未定时区。
   *
   * 基准必须是滚动容器的可见顶边，不是轨道的顶边：轨道装在滚动容器里，
   * 初始化滚动后 scrollTop 通常非 0，轨道的 rect.top 会跑到可见区上方，
   * 用它判断会恒为 false（曾因此让「拖到上方清除时间」失效、
   * 且搁板卡片上 1px 手抖被误判成拖进了轴里）。
   */
  const isAboveAxis = (clientY: number): boolean => {
    const el = scrollRef.current;
    if (!el) return false;
    return clientY < el.getBoundingClientRect().top;
  };

  const inShelf = (clientY: number): boolean => {
    const el = shelfRef.current;
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return clientY >= rect.top && clientY <= rect.bottom;
  };

  /* ── 提交 ──────────────────────────────────────────── */

  /**
   * 写回 store。`step` 决定吸附粒度：拖动用 SNAP_MIN，键盘的 1 分钟微调传 1。
   * 返回规范化后的区间，供调用方判断「是否真的需要写盘」。
   */
  const commit = (id: string, span: Span, step: number = SNAP_MIN): Span => {
    const n = normalizeRange(span, step);
    updateTask(date, id, { start: fmtMinutes(n.start), end: fmtMinutes(n.end) });
    return n;
  };

  const clearTime = (id: string) => updateTask(date, id, { start: undefined, end: undefined });

  /* ── 拖动 ──────────────────────────────────────────── */

  const beginBlockDrag = (e: React.PointerEvent<HTMLElement>, task: PlanTask, mode: DragMode) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // 必须阻止冒泡：块体自身也监听 pointerdown，否则拖边缘会被覆盖成整体平移
    e.stopPropagation();
    const span = axisRange(task);
    if (!span) return;
    capturePointer(e.currentTarget, e.pointerId);
    setSelected(task.id);
    setDrag({
      id: task.id,
      mode,
      origin: { ...span },
      grab: rawMinuteAt(e.clientY),
      next: { ...span },
      clearing: false,
    });
  };

  const beginShelfDrag = (e: React.PointerEvent<HTMLElement>, task: PlanTask) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    capturePointer(e.currentTarget, e.pointerId);
    setSelected(task.id);
    setDrag({
      id: task.id,
      mode: "assign",
      origin: { start: axisFrom, end: axisFrom + ASSIGN_MIN },
      grab: 0,
      next: null,
      clearing: false,
    });
  };

  const onDragMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!drag) return;

    if (drag.mode === "assign") {
      // 还没拖进轴的范围 → 没有预览
      if (isAboveAxis(e.clientY)) {
        setDrag((d) => (d?.next ? { ...d, next: null } : d));
        return;
      }
      // 指针落在块中间，块围绕指针上下展开
      const start = clampMinute(minuteAt(e.clientY) - ASSIGN_MIN / 2, axisFrom, DAY_END_MIN - ASSIGN_MIN);
      setDrag((d) => (d ? { ...d, next: { start, end: start + ASSIGN_MIN } } : d));
      return;
    }

    // 拖到轴上方 → 松手即清除时间。
    // 只对整体平移开放：拖边缘时向上越过轴顶是「把开始时间往前挪」的正常操作，
    // 不该被理解成删除时间 —— 那种误判会直接丢掉用户的数据。
    if (drag.mode === "move" && (inShelf(e.clientY) || isAboveAxis(e.clientY))) {
      setDrag((d) => (d ? { ...d, next: null, clearing: true } : d));
      return;
    }

    const next =
      drag.mode === "move"
        ? // 整体平移：位移取未吸附值之差，块原有的非整点偏移得以保留
          shiftRange(drag.origin.start, drag.origin.end, rawMinuteAt(e.clientY) - drag.grab, axisFrom, DAY_END_MIN)
        : // 拖边缘：绝对吸附到 5 分钟格，与时间选择器的粒度一致
          dragEdge(drag.origin.start, drag.origin.end, drag.mode, minuteAt(e.clientY), axisFrom, DAY_END_MIN);
    setDrag((d) => (d ? { ...d, next, clearing: false } : d));
  };

  const onDragUp = (e: React.PointerEvent<HTMLElement>) => {
    if (!drag) return;
    releasePointer(e.currentTarget, e.pointerId);
    // 原地点击（没真的拖动）不写盘。
    // 比较的是「规范化之后」的值：move 的预览用未吸附分钟数，1px 抖动就让它与原值不等，
    // 直接比较会白写一次盘 —— 而吸附后得到的其实是同一个时间。
    if (drag.clearing) {
      clearTime(drag.id);
    } else if (drag.next) {
      const raw = drag.next;
      const n = normalizeRange(raw);
      const unchanged = n.start === drag.origin.start && n.end === drag.origin.end;
      // assign 的 origin 是占位值，不能用它判断「有没有动」
      if (drag.mode === "assign" || !unchanged) commit(drag.id, raw);
    }
    setDrag(null);
  };

  // Esc 取消拖动（不写任何数据）
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrag(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drag]);

  /**
   * 键盘微调：↑↓ 平移，Shift+↑↓ 改终点，Alt+↑↓ 改起点，Ctrl 步长 1 分钟。
   *
   * 步长 1 分钟时必须把同一个粒度传给 commit，否则 normalizeRange 的 5 分钟
   * 吸附会把这一步位移抹回原值 —— 按键看起来完全没反应。
   */
  const onBlockKey = (e: React.KeyboardEvent, task: PlanTask) => {
    const step = e.ctrlKey || e.metaKey ? 1 : SNAP_MIN;
    const dir = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    if (!dir) return;
    const span = axisRange(task);
    if (!span) return;
    e.preventDefault();
    const next = e.altKey
      ? dragEdge(span.start, span.end, "start", span.start + dir, axisFrom, DAY_END_MIN)
      : e.shiftKey
        ? dragEdge(span.start, span.end, "end", span.end + dir, axisFrom, DAY_END_MIN)
        : shiftRange(span.start, span.end, dir, axisFrom, DAY_END_MIN);
    commit(task.id, next, step);
  };

  /* ── 展示 ──────────────────────────────────────────── */

  const durLabel = (mins: number) =>
    mins >= 60
      ? t("plans.hoursShort", { n: (mins / 60).toFixed(mins % 60 ? 1 : 0) })
      : t("plans.minutesShort", { n: mins });

  if (tasks.length === 0) {
    return <p className="py-6 text-center text-[13px] text-muted-foreground">{t("plans.emptyDay")}</p>;
  }

  return (
    <div className="flex flex-col gap-3 select-none">
      {/* ── 提示条 / 拖动实时读数 ── */}
      <div
        className={cn(
          "flex min-h-9 flex-wrap items-center gap-2 rounded-xl border px-3 py-1.5 transition-colors",
          dragging ? "border-brand/50 bg-brand/5" : "border-border bg-card",
        )}
      >
        {active ? (
          <>
            <span className="font-mono text-[12px] font-semibold tabular-nums text-brand">
              {fmtMinutes(active.start)} – {fmtMinutes(active.end)}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {durLabel(active.end - active.start)}
            </span>
            {drag?.mode === "assign" && (
              <span className="text-[11px] text-brand/80">{t("plans.timelineDropAssign")}</span>
            )}
          </>
        ) : drag?.clearing ? (
          <span className="text-[12px] font-medium text-destructive">
            {t("plans.timelineDropClear")}
          </span>
        ) : drag?.mode === "assign" ? (
          <span className="text-[12px] text-muted-foreground">{t("plans.timelineDropAssign")}</span>
        ) : (
          <span className="text-[11px] text-muted-foreground">{t("plans.timelineHint")}</span>
        )}

        <div className="flex-1" />

        <span className="text-[11px] text-muted-foreground/70">
          {t("plans.timelineUntimedCount", { count: untimed.length })}
        </span>
      </div>

      {/*
        ── 坐标轴（08:00–24:00），顶部那条虚线带就是「8 点之前」 ──
        未定时任务与轴共用一个框：轴只画 8 点之后的时段，
        8 点前那一段空出来放「还没排进今天」的任务。
        这样「拖到轴上方 = 清除时间」与「把任务放到 8 点前」是同一块区域，
        不需要再单独一个搁板框，也省下一整块纵向空间。
      */}
      <div
        className={cn(
          "overflow-hidden rounded-xl border bg-card transition-colors",
          assigning ? "border-brand/60" : "border-border",
        )}
      >
        {/* 8 点之前：未定时任务区 */}
        <div
          ref={shelfRef}
          className={cn(
            "flex min-h-[2.75rem] items-stretch gap-3 border-b border-dashed p-2 transition-colors",
            drag?.clearing
              ? "border-destructive/60 bg-destructive/5"
              : drag?.mode === "assign"
                ? "border-brand/50 bg-brand/[0.04]"
                : "border-border bg-muted/30",
          )}
        >
          <div
            className="flex shrink-0 flex-col items-end justify-center gap-0.5 pr-1 text-right"
            style={{ width: GUTTER - 8 }}
          >
            <span className="text-[10px] font-semibold text-muted-foreground">
              {t("plans.beforeEight")}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
              {untimed.length}
            </span>
          </div>

          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {untimed.length === 0 && (
              <span className="text-[11px] text-muted-foreground/60">
                {t("plans.timelineShelfEmpty")}
              </span>
            )}
            {untimed.map((task) => {
              const status = statusOf(task, date, now);
              const isDragging = drag?.id === task.id;
              return (
                <div
                  key={task.id}
                  onPointerDown={(e) => beginShelfDrag(e, task)}
                  onPointerMove={onDragMove}
                  onPointerUp={onDragUp}
                  onPointerCancel={onDragUp}
                  className={cn(
                    "flex max-w-[15rem] cursor-grab touch-none items-center gap-1.5 rounded-lg border bg-card px-2 py-1 transition-shadow active:cursor-grabbing",
                    isDragging
                      ? "border-brand opacity-40"
                      : selected === task.id
                        ? "border-brand/60 shadow-[var(--pr-shadow-1)]"
                        : "border-border hover:border-brand/40",
                  )}
                  title={t("plans.timelineShelfHint")}
                >
                  <span onPointerDown={(e) => e.stopPropagation()}>
                    <StatusButton
                      status={status}
                      onToggle={() => toggleDone(date, task.id)}
                      className="size-5"
                    />
                  </span>
                  <span className="min-w-0 truncate text-[11px]" style={doneTitleStyle(task.done)}>
                    {task.title}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* 时间轨道 */}
        <div
          ref={scrollRef}
          className="relative max-h-[30rem] min-h-[15rem] overflow-y-auto overscroll-contain"
        >
          <div className="flex" style={{ height }}>
            {/* 刻度栏 */}
            <div className="relative shrink-0" style={{ width: GUTTER }}>
              {ticks.map((m, i) => (
                <span
                  key={m}
                  className={cn(
                    "absolute right-2.5 -translate-y-1/2 font-mono text-[10px] tabular-nums",
                    // 24:00 只是轴的收尾，不标数字（它不是一天中的某个时刻）
                    i === ticks.length - 1 ? "hidden" : "text-muted-foreground",
                  )}
                  style={{ top: (m - axisFrom) * PX_PER_MIN }}
                >
                  {fmtMinutes(m)}
                </span>
              ))}
              {showNow && (
                <span
                  className="absolute right-2.5 -translate-y-1/2 font-mono text-[10px] font-semibold tabular-nums text-destructive"
                  style={{ top: (nowMin - axisFrom) * PX_PER_MIN }}
                >
                  {fmtMinutes(nowMin)}
                </span>
              )}
            </div>

            {/* 轨道 */}
            <div
              ref={trackRef}
              onPointerDown={() => setSelected(null)}
              className={cn("relative flex-1 border-l border-border", assigning && "bg-brand/[0.04]")}
            >
              {/* 整点线 */}
              {ticks.map((m) => (
                <div
                  key={m}
                  className="pointer-events-none absolute inset-x-0 border-t border-border/70"
                  style={{ top: (m - axisFrom) * PX_PER_MIN }}
                />
              ))}
              {/* 半点线（略淡） */}
              {ticks.slice(0, -1).map((m) => (
                <div
                  key={`half-${m}`}
                  className="pointer-events-none absolute inset-x-0 border-t border-dashed border-border/40"
                  style={{ top: (m + 30 - axisFrom) * PX_PER_MIN }}
                />
              ))}

              {/* 当前时刻 */}
              {showNow && (
                <div
                  className="pointer-events-none absolute inset-x-0 z-20 border-t border-destructive/80"
                  style={{ top: (nowMin - axisFrom) * PX_PER_MIN }}
                >
                  <span className="absolute -top-2 right-0 rounded bg-destructive px-1 text-[9px] font-semibold text-white">
                    {t("plans.timelineNow")}
                  </span>
                </div>
              )}

              {/*
                assign 预览块：拖入时被拖的任务还在 untimed 里（没有 start），
                下面的 timed.map 不会渲染它，所以这里单独画一个落点预览。
              */}
              {assigning && active && (
                <div
                  className="pointer-events-none absolute z-20 rounded-lg border border-brand border-dashed bg-brand/10"
                  style={{
                    top: (active.start - axisFrom) * PX_PER_MIN + 1,
                    height: Math.max((active.end - active.start) * PX_PER_MIN, MIN_BLOCK_PX),
                    left: 3,
                    right: 5,
                  }}
                >
                  <p className="truncate px-2 pt-0.5 font-mono text-[10px] tabular-nums text-brand">
                    {fmtMinutes(active.start)} – {fmtMinutes(active.end)}
                  </p>
                </div>
              )}

              {/* 时间块 */}
              {timed.map(({ task, span }) => {
                const d = drag?.id === task.id ? drag : null;
                const preview = d?.clearing ? span : (d?.next ?? span);
                const status = statusOf(task, date, now);
                const info = lanes.get(task.id) ?? { lane: 0, lanes: 1 };
                const laneW = 100 / info.lanes;

                const blockH = Math.max((preview.end - preview.start) * PX_PER_MIN - 2, MIN_BLOCK_PX);
                const compact = blockH < 28;
                const tall = blockH >= 44;
                const mins = preview.end - preview.start;
                // 矮块的上下热区要跟着缩小，否则 18px 的块会被两边吃掉、无处可拖
                const edgeH = Math.min(EDGE_MAX, Math.max(3, Math.floor(blockH / 3)));

                return (
                  <div
                    key={task.id}
                    tabIndex={0}
                    onPointerDown={(e) => beginBlockDrag(e, task, "move")}
                    onPointerMove={onDragMove}
                    onPointerUp={onDragUp}
                    onPointerCancel={onDragUp}
                    onKeyDown={(e) => onBlockKey(e, task)}
                    className={cn(
                      // touch-none：块长在纵向滚动容器里，触摸屏上若用默认 auto，
                      // 「纵向滑动滚动」会被当成拖动块、把划过的任务重排
                      "group absolute cursor-grab touch-none overflow-hidden rounded-lg border transition-shadow active:cursor-grabbing focus:outline-none",
                      // 拖动中的块浮到最上层：同 z 值按 DOM 顺序绘制，否则拖到后面的块上会被压住
                      d ? "z-30 shadow-[var(--pr-shadow-2)]" : "z-10",
                      STATUS_BOX[status],
                      selected === task.id && "ring-1 ring-brand/50",
                      d?.clearing && "border-dashed opacity-40",
                    )}
                    style={{
                      top: (preview.start - axisFrom) * PX_PER_MIN + 1,
                      height: blockH,
                      left: `calc(${info.lane * laneW}% + 3px)`,
                      width: `calc(${laneW}% - 5px)`,
                    }}
                    title={`${fmtMinutes(preview.start)} – ${fmtMinutes(preview.end)} · ${task.title}`}
                  >
                    {/* 状态色条 */}
                    <span
                      className={cn("absolute inset-y-0 left-0 w-[3px]", STATUS_STRIPE[status])}
                      aria-hidden
                    />

                    <div className="flex min-w-0 items-center gap-1.5 pt-0.5 pr-5 pl-2">
                      <span
                        onPointerDown={(e) => e.stopPropagation()}
                        className={compact ? "hidden" : "shrink-0"}
                      >
                        <StatusButton
                          status={status}
                          onToggle={() => toggleDone(date, task.id)}
                          className="size-5"
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            "truncate leading-4",
                            compact ? "text-[10px]" : "text-[12px]",
                          )}
                          style={doneTitleStyle(task.done)}
                        >
                          {task.title}
                        </p>
                        {!compact && (
                          <p className="truncate font-mono text-[10px] tabular-nums text-muted-foreground/80">
                            {fmtMinutes(preview.start)} – {fmtMinutes(preview.end)}
                            {tall && ` · ${durLabel(mins)}`}
                          </p>
                        )}
                        {tall && task.note && (
                          <p className="truncate text-[10px] text-muted-foreground/70">
                            {task.note}
                          </p>
                        )}
                      </div>
                    </div>

                    {/*
                      清除时间（拖到轴上方 = 未定时区的等价快捷方式）。
                      z-20 必须高于上下边缘热区的 z-10：否则按钮上 1/3 会落进
                      「上边缘 = 改起点」的命中区，点它会改开始时间而不是清除。
                    */}
                    {!compact && (
                      <button
                        type="button"
                        title={t("plans.clearTime")}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => clearTime(task.id)}
                        className="absolute top-0.5 right-0.5 z-20 hidden size-4 place-items-center rounded text-muted-foreground/70 group-hover:grid hover:bg-muted hover:text-foreground"
                      >
                        <RotateCcw className="size-3" />
                      </button>
                    )}

                    {/*
                      上下边缘热区。只挂 pointerdown —— move/up 交给块体统一处理：
                      两者都挂的话，边缘拖动时 pointerup 会在 span 上派发后冒泡到块体，
                      两个 onDragUp 读到同一份（尚未更新的）drag，提交与清除各执行两次。
                    */}
                    <span
                      role="separator"
                      aria-label={t("plans.timeStart")}
                      onPointerDown={(e) => beginBlockDrag(e, task, "start")}
                      className="absolute inset-x-0 top-0 z-10 cursor-ns-resize"
                      style={{ height: edgeH }}
                    >
                      <span className="absolute inset-x-3 top-[2px] hidden h-[2px] rounded-full bg-brand/70 group-hover:block" />
                    </span>

                    <span
                      role="separator"
                      aria-label={t("plans.timeEnd")}
                      onPointerDown={(e) => beginBlockDrag(e, task, "end")}
                      className="absolute inset-x-0 bottom-0 z-10 cursor-ns-resize"
                      style={{ height: edgeH }}
                    >
                      <span className="absolute inset-x-3 bottom-[2px] hidden h-[2px] rounded-full bg-brand/70 group-hover:block" />
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
