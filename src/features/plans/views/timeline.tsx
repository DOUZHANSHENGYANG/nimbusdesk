import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import {
  DAY_END_MIN,
  SNAP_MIN,
  axisBounds,
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

/**
 * 时间轴视图：全天纵向坐标轴 + 可拖拽时间块。
 *
 * 轴是固定的 00:00–24:00（24 小时 × 60px = 1440px），装在一个内部滚动容器里，
 * 进入时自动滚到当天最早任务所在的小时。
 *
 * 为什么不做成「按任务撑开的紧凑轴」：那样一旦想把任务拖到 22:00 之后，
 * 就必须让轴在拖动过程中长高，而轴一变，指针→分钟的映射就跟着变，
 * 块会在光标下漂移、来回振荡。固定轴让映射恒定，也顺手解决了
 * 「时间只能落在 08:00–22:00 之间」这个功能缺口 —— 时间应当能放到一天中的任何位置。
 *
 * 交互（与栅栏、文件页的「单击选中 / 拖动移动」保持一致）：
 * - 拖块体 → 整体平移（保持时长）
 * - 拖块的上/下边缘 → 只动起点 / 只动终点（最短 15 分钟）
 * - 把未定时卡片拖到轴上 → 设定时间（默认 1 小时）
 * - 把轴上的块拖到未定时区 → 清除时间（块上也有 ✕ 按钮）
 * - ↑↓ 平移、Shift+↑↓ 改终点、Alt+↑↓ 改起点、按住 Ctrl 步长 1 分钟
 *
 * 拖动过程只更新本地预览，松手才写一次 store —— 避免每像素一次落盘与跨窗口广播。
 */

/** 每小时像素高度（24 小时 = 1440px） */
const PX_PER_HOUR = 60;
const PX_PER_MIN = PX_PER_HOUR / 60;
/** 左侧时间刻度栏宽度 */
const GUTTER = 56;
/** 上/下边缘拖拽热区高度上限 */
const EDGE_MAX = 7;
/** 拖入时新建块的默认时长（分钟） */
const ASSIGN_MIN = 60;
/** 块的最小可见高度：15 分钟的块只有 15px，再矮就连标题都放不下 */
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
  /** 预览区间；null = 当前不在轴上（assign 尚未进入） */
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

  /** 有时间 → 块；没时间 → 未定时搁板 */
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

  const ticks = useMemo(() => Array.from({ length: 25 }, (_, h) => h * 60), []);
  const height = 24 * PX_PER_HOUR;

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const showNow = date === todayStr();
  const dragging = drag != null;
  const active = drag?.next ?? null;
  const assigning = drag?.mode === "assign" && active != null;

  /**
   * 初次进入 / 换日期时滚到当天最早任务所在的小时。
   *
   * 依赖里必须带 tasks.length：本页在 store 尚未 hydrate 时就会挂载，
   * 那一刻 tasks 是空数组、axisBounds 返回默认 08:00；等 hydrate 完成、
   * 任务出现后若不重跑，视口就停在 08:00 而不是最早任务处。
   *
   * 用长度而不是 tasks 本身：拖动落盘会让 tasks 换新引用但长度不变，
   * 那时不该把视口拽走（拖动中视口跳动会让块在光标下漂移）。
   * 代价是「任务数不变但时间整体改变」时不会重新定位 —— 可以接受。
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchor = Math.max(axisBounds(tasks).from - 30, 0);
    el.scrollTop = anchor * PX_PER_MIN;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, tasks.length]);

  /* ── 坐标换算 ──────────────────────────────────────── */

  /**
   * 指针所在的分钟数（未吸附）。
   *
   * 用 getBoundingClientRect()：它给的是元素当前视口位置，滚动时 top 会跟着变，
   * 于是 (clientY - top) 自动补偿了滚动量 —— 拖动中滚轮滚动也不会算错。
   */
  const rawMinuteAt = (clientY: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    return (clientY - el.getBoundingClientRect().top) / PX_PER_MIN;
  };

  /** 指针所在的分钟数（吸附到 SNAP_MIN，夹在一天内） */
  const minuteAt = (clientY: number): number =>
    clampMinute(snapMinute(rawMinuteAt(clientY)), 0, DAY_END_MIN);

  /** 指针在轴上方（未定时搁板所在的那一带） */
  const isAboveAxis = (clientY: number): boolean => {
    const el = trackRef.current;
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

  const commit = (id: string, span: Span) => {
    const n = normalizeRange(span);
    updateTask(date, id, { start: fmtMinutes(n.start), end: fmtMinutes(n.end) });
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
    e.currentTarget.setPointerCapture(e.pointerId);
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
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelected(task.id);
    setDrag({
      id: task.id,
      mode: "assign",
      origin: { start: 0, end: ASSIGN_MIN },
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
        if (drag.next) setDrag({ ...drag, next: null });
        return;
      }
      // 指针落在块中间，块围绕指针左右展开
      const start = clampMinute(minuteAt(e.clientY) - ASSIGN_MIN / 2, 0, DAY_END_MIN - ASSIGN_MIN);
      setDrag({ ...drag, next: { start, end: start + ASSIGN_MIN } });
      return;
    }

    // 拖到未定时区 → 松手即清除时间。
    // 只对整体平移开放：拖边缘时向上越过轴顶是「把开始时间往前挪」的正常操作，
    // 不该被理解成删除时间 —— 那种误判会直接丢掉用户的数据。
    if (drag.mode === "move" && (inShelf(e.clientY) || isAboveAxis(e.clientY))) {
      if (!drag.clearing) setDrag({ ...drag, next: null, clearing: true });
      return;
    }

    const next =
      drag.mode === "move"
        ? // 整体平移：位移取未吸附值之差，块原有的非整点偏移得以保留
          shiftRange(drag.origin.start, drag.origin.end, rawMinuteAt(e.clientY) - drag.grab, 0, DAY_END_MIN)
        : // 拖边缘：绝对吸附到 5 分钟格，与时间选择器的粒度一致
          dragEdge(
            drag.origin.start,
            drag.origin.end,
            drag.mode,
            minuteAt(e.clientY),
            0,
            DAY_END_MIN,
          );
    setDrag({ ...drag, next, clearing: false });
  };

  const onDragUp = (e: React.PointerEvent<HTMLElement>) => {
    if (!drag) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // 原地点击（没真的拖动）不写盘：否则一次误点就触发一次无意义的持久化与跨窗口广播。
    // 注意是「任一端变了」——用 && 会让「只拖起点」或「只拖终点」被判成没动而丢掉这次修改。
    const moved =
      drag.next != null &&
      (drag.next.start !== drag.origin.start || drag.next.end !== drag.origin.end);
    if (drag.clearing) clearTime(drag.id);
    // assign 的 origin 是占位值，不能用它判断「有没有动」
    else if (drag.mode === "assign" ? drag.next != null : moved && drag.next) {
      commit(drag.id, drag.next!);
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

  /** 键盘微调：↑↓ 平移，Shift+↑↓ 改终点，Alt+↑↓ 改起点，Ctrl 步长 1 分钟 */
  const onBlockKey = (e: React.KeyboardEvent, task: PlanTask) => {
    const step = e.ctrlKey || e.metaKey ? 1 : SNAP_MIN;
    const dir = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    if (!dir) return;
    const span = axisRange(task);
    if (!span) return;
    e.preventDefault();
    const next = e.altKey
      ? dragEdge(span.start, span.end, "start", snapMinute(span.start + dir), 0, DAY_END_MIN)
      : e.shiftKey
        ? dragEdge(span.start, span.end, "end", snapMinute(span.end + dir), 0, DAY_END_MIN)
        : shiftRange(span.start, span.end, dir, 0, DAY_END_MIN);
    commit(task.id, next);
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

        {showNow && (
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
            {t("plans.timelineNow")} {fmtMinutes(nowMin)}
          </span>
        )}
      </div>

      {/*
        ── 未定时区（时间轴上方） ──
        始终渲染，不按内容/拖动状态增减。
        若它在拖动开始时才出现，坐标轴会被整体下移，块就在光标下跳位了 ——
        而块的位置正是靠 rect.top 换算出来的。几何必须恒定。
        它同时是「拖走 = 清除时间」的放置目标，常驻也让它更容易被发现。
      */}
      <div
        ref={shelfRef}
        className={cn(
          "flex min-h-[3.25rem] items-stretch gap-3 rounded-xl border border-dashed p-2 transition-colors",
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
            {t("plans.untimed")}
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
                  "flex max-w-[15rem] cursor-grab items-center gap-1.5 rounded-lg border bg-card px-2 py-1 transition-shadow active:cursor-grabbing",
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

      {/* ── 坐标轴（固定全天，内部滚动） ── */}
      <div
        className={cn(
          "overflow-hidden rounded-xl border bg-card transition-colors",
          assigning ? "border-brand/60" : "border-border",
        )}
      >
        <div
          ref={scrollRef}
          className="relative h-[calc(100vh-22rem)] max-h-[40rem] min-h-[22rem] overflow-y-auto overscroll-contain"
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
                  style={{ top: m * PX_PER_MIN }}
                >
                  {fmtMinutes(m)}
                </span>
              ))}
              {showNow && (
                <span
                  className="absolute right-2.5 -translate-y-1/2 font-mono text-[10px] font-semibold tabular-nums text-destructive"
                  style={{ top: nowMin * PX_PER_MIN }}
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
                  style={{ top: m * PX_PER_MIN }}
                />
              ))}
              {/* 半点线（略淡） */}
              {ticks.slice(0, -1).map((m) => (
                <div
                  key={`half-${m}`}
                  className="pointer-events-none absolute inset-x-0 border-t border-dashed border-border/40"
                  style={{ top: (m + 30) * PX_PER_MIN }}
                />
              ))}

              {/* 当前时刻 */}
              {showNow && (
                <div
                  className="pointer-events-none absolute inset-x-0 z-20 border-t border-destructive/80"
                  style={{ top: nowMin * PX_PER_MIN }}
                >
                  <span className="absolute -top-2 right-0 rounded bg-destructive px-1 text-[9px] font-semibold text-white">
                    {t("plans.timelineNow")}
                  </span>
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
                const compact = blockH < 30;
                const tall = blockH >= 48;
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
                      "group absolute z-10 cursor-grab overflow-hidden rounded-lg border transition-shadow active:cursor-grabbing focus:outline-none",
                      STATUS_BOX[status],
                      selected === task.id && "ring-1 ring-brand/50",
                      d && "shadow-[var(--pr-shadow-2)]",
                      d?.clearing && "border-dashed opacity-40",
                    )}
                    style={{
                      top: preview.start * PX_PER_MIN + 1,
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

                    {/* 清除时间（拖回未定时区的等价快捷方式） */}
                    {!compact && (
                      <button
                        type="button"
                        title={t("plans.clearTime")}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => clearTime(task.id)}
                        className="absolute top-0.5 right-0.5 hidden size-4 place-items-center rounded text-muted-foreground/70 group-hover:grid hover:bg-muted hover:text-foreground"
                      >
                        <RotateCcw className="size-3" />
                      </button>
                    )}

                    {/* 上边缘 = 改起点 */}
                    <span
                      role="separator"
                      aria-label={t("plans.timeStart")}
                      onPointerDown={(e) => beginBlockDrag(e, task, "start")}
                      onPointerMove={onDragMove}
                      onPointerUp={onDragUp}
                      onPointerCancel={onDragUp}
                      className="absolute inset-x-0 top-0 z-10 cursor-ns-resize"
                      style={{ height: edgeH }}
                    >
                      <span className="absolute inset-x-3 top-[2px] hidden h-[2px] rounded-full bg-brand/70 group-hover:block" />
                    </span>

                    {/* 下边缘 = 改终点 */}
                    <span
                      role="separator"
                      aria-label={t("plans.timeEnd")}
                      onPointerDown={(e) => beginBlockDrag(e, task, "end")}
                      onPointerMove={onDragMove}
                      onPointerUp={onDragUp}
                      onPointerCancel={onDragUp}
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
