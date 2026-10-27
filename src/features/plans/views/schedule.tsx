import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addDays,
  axisRange,
  clampMinute,
  dayProgress,
  fmtDate,
  fmtMinutes,
  monthGrid,
  normalizeRange,
  parseDate,
  shiftRange,
  statusOf,
  todayStr,
  DAY_END_MIN,
  SNAP_MIN,
} from "@/features/plans/types";
import { useNow, usePlans, usePlansArchive } from "@/features/plans/store";
import { cn } from "@/lib/utils";
import { capturePointer, releasePointer } from "@/lib/touch";
import { eventTint, LunarText } from "./shared";

/**
 * 日程视图：日 / 周 / 年三档（月档由 CalendarView 负责）。
 *
 * 为什么不把四档塞进一个组件：月视图是「格子里塞任务名」的网格，
 * 周/日是「时间轴 × 多列」的甘特式布局，年视图是「12 个月格、每格列当天的事」，
 * 三者的几何与交互没有共享部分。硬合并只会得到一个到处都是 if 的组件。
 *
 * 这一版只做只读浏览（点选日期、点任务跳日），不做拖拽改期 ——
 * 拖拽改期需要跨日期写 store，风险远高于浏览，留待确认需求后再加。
 */

/** 时间轴范围：08:00 起，24:00 止（与 timeline 视图口径一致） */
const AXIS_FROM = 8 * 60;
const AXIS_TO = 24 * 60;
const PX_PER_HOUR = 40;
const HOURS = (AXIS_TO - AXIS_FROM) / 60;
const PX_PER_MIN = PX_PER_HOUR / 60;

export type ScheduleMode = "day" | "week" | "year";

/** 一次拖拽改期：横向换天、纵向换时间，松手才写 store */
interface DragState {
  id: string;
  from: string;
  origin: { start: number; end: number };
  /** 按下时指针所在分钟（未吸附），整体平移靠它保留非整点偏移 */
  grab: number;
  /** 预览：目标日期 + 区间 */
  next: { date: string; start: number; end: number };
}

function startOfWeek(dateStr: string): string {
  const d = parseDate(dateStr);
  const offset = (d.getDay() + 6) % 7; // 周一为一周起点
  return fmtDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset));
}

export function ScheduleView({
  date,
  mode,
  onPick,
}: {
  date: string;
  mode: ScheduleMode;
  onPick: (date: string) => void;
}) {
  if (mode === "year") return <YearView date={date} onPick={onPick} />;
  return <TimeGrid date={date} mode={mode === "week" ? "week" : "day"} onPick={onPick} />;
}

/* ── 日/周共用的时间网格：可拖拽改期（横向换天、纵向换时间） ── */

function TimeGrid({ date, mode, onPick }: { date: string; mode: "day" | "week"; onPick: (date: string) => void }) {
  const { t } = useTranslation();
  const days = usePlans((s) => s.days);
  const archive = usePlansArchive((s) => s.days);
  const moveTaskToDate = usePlans((s) => s.moveTaskToDate);
  const now = useNow();
  const today = todayStr();
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const weekStartDate = startOfWeek(date);
  const columns = useMemo(
    () => (mode === "week" ? Array.from({ length: 7 }, (_, i) => addDays(weekStartDate, i)) : [date]),
    [mode, weekStartDate, date],
  );
  const weekdayLabels = useMemo(
    () => columns.map((cell) => new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(parseDate(cell))),
    [columns],
  );

  const tasksOf = (cell: string) => days[cell] ?? archive[cell]?.tasks ?? [];

  /** 指针 → 时间轴分钟（未吸附；整体平移靠差值保留原有偏移） */
  const rawMinuteAt = (clientY: number): number => {
    const el = trackRef.current;
    if (!el) return AXIS_FROM;
    return AXIS_FROM + (clientY - el.getBoundingClientRect().top) / PX_PER_MIN;
  };
  /** 指针 → 落在哪一列（周视图横向换天） */
  const columnAt = (clientX: number): string => {
    const el = trackRef.current;
    if (!el) return columns[0]!;
    const rect = el.getBoundingClientRect();
    const gutter = 56;
    const width = (rect.width - gutter) / columns.length;
    const index = clampMinute(Math.floor((clientX - rect.left - gutter) / width), 0, columns.length - 1);
    return columns[index]!;
  };

  const beginDrag = (event: React.PointerEvent<HTMLElement>, cell: string, taskId: string) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const task = tasksOf(cell).find((item) => item.id === taskId);
    const span = task ? axisRange(task) : null;
    if (!task || !span) return;
    capturePointer(event.currentTarget, event.pointerId);
    setDrag({
      id: taskId,
      from: cell,
      origin: { ...span },
      grab: rawMinuteAt(event.clientY),
      next: { date: cell, ...span },
    });
  };

  const onMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!drag) return;
    // 整体平移：位移用未吸附差值，保留任务原有的非整点偏移
    const span = shiftRange(drag.origin.start, drag.origin.end,
      rawMinuteAt(event.clientY) - drag.grab, AXIS_FROM, DAY_END_MIN);
    setDrag((d) => (d ? { ...d, next: { date: columnAt(event.clientX), ...span } } : d));
  };

  const onUp = (event: React.PointerEvent<HTMLElement>) => {
    if (!drag) return;
    releasePointer(event.currentTarget, event.pointerId);
    const target = drag.next;
    const normalized = normalizeRange({ start: target.start, end: target.end }, SNAP_MIN);
    const sameSlot = target.date === drag.from
      && normalized.start === drag.origin.start
      && normalized.end === drag.origin.end;
    // 原地点击（没真拖）不写盘
    if (!sameSlot) {
      moveTaskToDate(drag.from, drag.id, target.date, {
        start: fmtMinutes(normalized.start),
        end: fmtMinutes(normalized.end),
      });
      if (target.date !== drag.from) onPick(target.date);
    }
    setDrag(null);
  };

  /** 块的定位与着色（拖拽中的块用预览位置渲染） */
  const blockStyle = (cell: string, taskId: string, span: { start: number; end: number }) => {
    const preview = drag?.id === taskId && drag.next.date === cell ? drag.next : null;
    const range = preview ?? span;
    const column = columns.indexOf(cell);
    return {
      top: ((range.start - AXIS_FROM) / 60) * PX_PER_HOUR,
      height: Math.max(((range.end - range.start) / 60) * PX_PER_HOUR, 18),
      left: `calc(56px + ${column} * (100% - 56px) / ${columns.length} + 2px)`,
      width: `calc((100% - 56px) / ${columns.length} - 4px)`,
    };
  };

  const isDragging = (taskId: string) => drag?.id === taskId;

  return (
    <div className="flex flex-col gap-2">
      {mode === "day" && (
        <div className="flex items-center justify-between px-1">
          <span className="text-[13px] font-semibold">
            {new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", weekday: "long" }).format(parseDate(date))}
          </span>
          {(() => {
            const list = tasksOf(date);
            const progress = list.length ? dayProgress(list) : null;
            return progress ? (
              <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-brand">
                {progress.done}/{progress.total}
              </span>
            ) : null;
          })()}
        </div>
      )}

      {mode === "day" && tasksOf(date).some((task) => axisRange(task) === null && !task.parentId) && (
        <div className="flex flex-wrap gap-1.5 rounded-lg border border-dashed border-border p-2">
          {tasksOf(date).filter((task) => axisRange(task) === null && !task.parentId).map((task) => (
            <span key={task.id} title={task.title}
              className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground/80">
              {task.title}
            </span>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-border"
        onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
        {/* 表头 */}
        <div className="flex border-b border-border bg-card/50">
          <span className="w-14 shrink-0" />
          {columns.map((cell, index) => {
            const list = tasksOf(cell);
            const progress = list.length ? dayProgress(list) : null;
            const isToday = cell === today;
            return (
              <button key={cell} type="button" onClick={() => onPick(cell)}
                className={cn(
                  "flex flex-1 flex-col items-center gap-0.5 py-1.5 transition-colors hover:bg-surface-hover",
                  drag?.next.date === cell && "bg-brand/15",
                  cell === date && !drag && "bg-brand/10",
                )}>
                <span className="text-[10px] text-muted-foreground">
                  {mode === "week" ? weekdayLabels[index] : ""}
                </span>
                <span className={cn(
                  "grid size-5 place-items-center rounded-full text-[11px] font-semibold",
                  isToday && "bg-brand text-white",
                )}>
                  {parseDate(cell).getDate()}
                </span>
                {progress && <span className="text-[9px] tabular-nums text-muted-foreground">{progress.done}/{progress.total}</span>}
              </button>
            );
          })}
        </div>

        {/* 时间网格 + 任务块 */}
        <div className="relative" ref={trackRef}>
          {Array.from({ length: HOURS }, (_, i) => {
            const hour = AXIS_FROM / 60 + i;
            return (
              <div key={hour} className="flex" style={{ height: PX_PER_HOUR }}>
                <span className="w-14 shrink-0 border-r border-border py-0.5 pr-1.5 text-right font-mono text-[10px] text-muted-foreground">
                  {String(hour).padStart(2, "0")}
                </span>
                {columns.map((cell) => (
                  <span key={cell} className={cn(
                    "flex-1 border-b border-r border-border/50",
                    cell === today && "bg-brand/[0.03]",
                    drag?.next.date === cell && "bg-brand/[0.07]",
                  )} />
                ))}
              </div>
            );
          })}

          {columns.map((cell) => tasksOf(cell).map((task) => {
            const span = axisRange(task);
            if (!span || span.start < AXIS_FROM) return null;
            const status = statusOf(task, cell, now);
            return (
              <span key={`${cell}-${task.id}`}
                data-chip
                title={`${task.start ?? ""}${task.end ? `–${task.end}` : ""} ${task.title}（可拖动改期）`}
                onPointerDown={(event) => beginDrag(event, cell, task.id)}
                className={cn(
                  "absolute cursor-grab touch-none select-none truncate rounded px-1.5 text-[10px] leading-4 active:cursor-grabbing",
                  status === "done" ? "bg-muted text-muted-foreground line-through"
                    : status === "doing" ? "bg-brand text-white"
                      : eventTint(task),
                  isDragging(task.id) && "opacity-70 ring-2 ring-brand",
                )}
                style={blockStyle(cell, task.id, span)}>
                {task.title}
              </span>
            );
          }))}
        </div>
      </div>

      {columns.every((cell) => tasksOf(cell).length === 0) && (
        <p className="py-4 text-center text-[13px] text-muted-foreground">
          {mode === "week" ? t("plans.emptyWeek") : t("plans.emptyDay")}
        </p>
      )}
    </div>
  );
}
/* ── 年视图：12 个月格，每格把当天的事列出来 ──────────────── */

/**
 * 每格最多列几条。比月视图的 3 还少 —— 年视图一个格子只有 ~62px 宽（1440 三列时），
 * 多列一条整年就要多滚一屏，「一眼看一年」的用处就没了，剩下的用「+N 项」收口。
 */
const YEAR_CHIPS = 2;

function YearView({ date, onPick }: { date: string; onPick: (date: string) => void }) {
  const { t, i18n } = useTranslation();
  const days = usePlans((s) => s.days);
  const archive = usePlansArchive((s) => s.days);
  const now = useNow();
  const year = parseDate(date).getFullYear();
  const today = todayStr();

  // 周一为起点，与月视图、周视图同一口径（2024-01-01 是周一）
  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.language === "en" ? "en-US" : "zh-CN", { weekday: "narrow" });
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
  }, [i18n.language]);

  const months = useMemo(
    () =>
      Array.from({ length: 12 }, (_, month) => ({
        month,
        label: new Intl.DateTimeFormat(i18n.language === "en" ? "en-US" : "zh-CN", { month: "short" }).format(
          new Date(year, month, 1),
        ),
        // 复用 monthGrid：42 格、周一起，与月视图同源，免得两处口径漂移
        cells: monthGrid(year, month).map(({ date: cell, inMonth }) => ({
          date: cell,
          inMonth,
          tasks: days[cell] ?? archive[cell]?.tasks ?? [],
        })),
      })),
    [year, days, archive, i18n.language],
  );

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {months.map(({ month, label, cells }) => (
        <div key={month} data-month={month} className="rounded-xl border border-border p-2">
          <p className="mb-1 text-[11px] font-semibold text-muted-foreground">{label}</p>
          <div className="grid grid-cols-7 gap-px">
            {weekdayLabels.map((w) => (
              <span key={w} data-dow={w} className="pb-px text-center text-[9px] leading-3 text-muted-foreground">
                {w}
              </span>
            ))}
            {cells.map((cell) => {
              const shown = cell.tasks.slice(0, YEAR_CHIPS);
              const rest = cell.tasks.length - shown.length;
              const done = cell.tasks.filter((task) => task.done).length;
              return (
                <button
                  key={cell.date}
                  type="button"
                  data-day={cell.date}
                  onClick={() => onPick(cell.date)}
                  title={`${cell.date}${cell.tasks.length ? ` · ${done}/${cell.tasks.length}` : ""}`}
                  className={cn(
                    "flex min-h-8 flex-col gap-px overflow-hidden rounded border border-transparent p-0.5 text-left transition-colors duration-150",
                    !cell.inMonth && "opacity-35",
                    cell.date === today ? "border-brand" : "hover:border-muted-foreground/40 hover:bg-surface-hover",
                  )}
                >
                  <span className="flex min-w-0 items-baseline gap-1">
                    <span
                      className={cn(
                        "text-[9px] font-semibold leading-3 tabular-nums",
                        cell.date === today ? "text-brand" : "text-muted-foreground",
                      )}
                    >
                      {parseDate(cell.date).getDate()}
                    </span>
                    <LunarText date={cell.date} className="text-[9px]" />
                  </span>
                  {/* 只列标题：62px 的格子里再加时间前缀，标题就一个字都看不见了 */}
                  {shown.map((task) => {
                    const status = statusOf(task, cell.date, now);
                    return (
                      <span
                        key={task.id}
                        data-chip
                        title={task.title}
                        className={cn(
                          "block w-full truncate rounded px-0.5 text-[9px] leading-3",
                          status === "done"
                            ? "bg-muted/60 text-muted-foreground line-through"
                            : status === "doing"
                              ? "bg-brand text-white"
                              : eventTint(task),
                        )}
                      >
                        {task.title}
                      </span>
                    );
                  })}
                  {rest > 0 && (
                    <span className="px-0.5 text-[9px] leading-3 text-muted-foreground">
                      {t("plans.moreTasks", { count: rest })}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
