import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addDays,
  axisRange,
  dayProgress,
  fmtDate,
  parseDate,
  statusOf,
  todayStr,
} from "@/features/plans/types";
import { useNow, usePlans, usePlansArchive } from "@/features/plans/store";
import { cn } from "@/lib/utils";

/**
 * 日程视图：日 / 周 / 年三档（月档由 CalendarView 负责）。
 *
 * 为什么不把四档塞进一个组件：月视图是「格子里塞任务名」的网格，
 * 周/日是「时间轴 × 多列」的甘特式布局，年视图是「12 个月的热力概览」，
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

export type ScheduleMode = "day" | "week" | "year";

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
  if (mode === "week") return <WeekView date={date} onPick={onPick} />;
  return <DayView date={date} />;
}

/* ── 日视图：单日时间轴 + 未定时列表 ─────────────────────── */

function DayView({ date }: { date: string }) {
  const { t } = useTranslation();
  const days = usePlans((s) => s.days);
  const archive = usePlansArchive((s) => s.days);
  const now = useNow();
  const tasks = days[date] ?? archive[date]?.tasks ?? [];
  const timed = tasks.filter((task) => axisRange(task) !== null);
  const untimed = tasks.filter((task) => axisRange(task) === null && !task.parentId);
  const progress = tasks.length ? dayProgress(tasks) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-[13px] font-semibold">
          {new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", weekday: "long" }).format(parseDate(date))}
        </span>
        {progress && (
          <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-brand">
            {progress.done}/{progress.total}
          </span>
        )}
      </div>

      {untimed.length > 0 && (
        <div className="flex flex-wrap gap-1.5 rounded-lg border border-dashed border-border p-2">
          {untimed.map((task) => (
            <span key={task.id}
              className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground/80"
              title={task.title}>
              {task.title}
            </span>
          ))}
        </div>
      )}

      <div className="relative overflow-hidden rounded-xl border border-border">
        {Array.from({ length: HOURS }, (_, i) => {
          const hour = AXIS_FROM / 60 + i;
          return (
            <div key={hour} className="flex" style={{ height: PX_PER_HOUR }}>
              <span className="w-14 shrink-0 border-r border-border py-0.5 pr-1.5 text-right font-mono text-[10px] text-muted-foreground">
                {String(hour).padStart(2, "0")}:00
              </span>
              <span className="flex-1 border-b border-border/60" />
            </div>
          );
        })}
        {timed.map((task) => {
          const range = axisRange(task)!;
          const top = ((range.start - AXIS_FROM) / 60) * PX_PER_HOUR;
          const height = Math.max(((range.end - range.start) / 60) * PX_PER_HOUR, 18);
          const status = statusOf(task, date, now);
          return (
            <span key={task.id} title={`${task.start ?? ""}${task.end ? `–${task.end}` : ""} ${task.title}`}
              className={cn(
                "absolute left-[60px] right-1.5 truncate rounded px-1.5 py-0.5 text-[11px] leading-4",
                status === "done" ? "bg-muted text-muted-foreground line-through"
                  : status === "doing" ? "bg-brand text-white"
                    : "bg-brand/12 text-foreground ring-1 ring-inset ring-brand/25",
              )}
              style={{ top, height }}>
              {task.title}
            </span>
          );
        })}
      </div>
      {tasks.length === 0 && <p className="py-6 text-center text-[13px] text-muted-foreground">{t("plans.emptyDay")}</p>}
    </div>
  );
}

/* ── 周视图：7 列 × 时间轴 ──────────────────────────────── */

function WeekView({ date, onPick }: { date: string; onPick: (date: string) => void }) {
  const { t } = useTranslation();
  const days = usePlans((s) => s.days);
  const archive = usePlansArchive((s) => s.days);
  const now = useNow();
  const today = todayStr();
  const start = startOfWeek(date);
  const week = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(start, i)), [start]);

  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
    return week.map((d) => fmt.format(parseDate(d)));
  }, [week]);

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      {/* 表头：星期 + 日期 + 当天进度 */}
      <div className="flex border-b border-border bg-card/50">
        <span className="w-14 shrink-0" />
        {week.map((cell, index) => {
          const tasks = days[cell] ?? archive[cell]?.tasks ?? [];
          const progress = tasks.length ? dayProgress(tasks) : null;
          const isToday = cell === today;
          return (
            <button key={cell} type="button" onClick={() => onPick(cell)}
              className={cn(
                "flex flex-1 flex-col items-center gap-0.5 py-1.5 transition-colors hover:bg-surface-hover",
                cell === date && "bg-brand/10",
              )}>
              <span className="text-[10px] text-muted-foreground">{weekdayLabels[index]}</span>
              <span className={cn(
                "grid size-5 place-items-center rounded-full text-[11px] font-semibold",
                isToday && "bg-brand text-white",
              )}>
                {parseDate(cell).getDate()}
              </span>
              {progress && (
                <span className="text-[9px] tabular-nums text-muted-foreground">{progress.done}/{progress.total}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* 时间网格 */}
      <div className="relative">
        {Array.from({ length: HOURS }, (_, i) => {
          const hour = AXIS_FROM / 60 + i;
          return (
            <div key={hour} className="flex" style={{ height: PX_PER_HOUR }}>
              <span className="w-14 shrink-0 border-r border-border py-0.5 pr-1.5 text-right font-mono text-[10px] text-muted-foreground">
                {String(hour).padStart(2, "0")}
              </span>
              {week.map((cell) => (
                <span key={cell} className={cn("flex-1 border-b border-r border-border/50", cell === today && "bg-brand/[0.03]")} />
              ))}
            </div>
          );
        })}

        {/* 任务块：按天分列、按时间定位 */}
        {week.map((cell, index) => {
          const tasks = days[cell] ?? archive[cell]?.tasks ?? [];
          return tasks.map((task) => {
            const range = axisRange(task);
            if (!range || range.start < AXIS_FROM) return null;
            const top = ((range.start - AXIS_FROM) / 60) * PX_PER_HOUR;
            const height = Math.max(((range.end - range.start) / 60) * PX_PER_HOUR, 16);
            const status = statusOf(task, cell, now);
            const columnWidth = `calc((100% - 56px) / 7)`;
            return (
              <span key={`${cell}-${task.id}`} title={`${task.title} ${task.start ?? ""}`}
                className={cn(
                  "absolute truncate rounded px-1 text-[10px] leading-4",
                  status === "done" ? "bg-muted text-muted-foreground line-through"
                    : status === "doing" ? "bg-brand text-white"
                      : "bg-brand/12 text-foreground ring-1 ring-inset ring-brand/25",
                )}
                style={{ top, height, left: `calc(56px + ${index} * ${columnWidth} + 2px)`, width: `calc(${columnWidth} - 4px)` }}>
                {task.title}
              </span>
            );
          });
        })}
      </div>

      {week.every((cell) => (days[cell] ?? archive[cell]?.tasks ?? []).length === 0) && (
        <p className="py-6 text-center text-[13px] text-muted-foreground">{t("plans.emptyWeek")}</p>
      )}
    </div>
  );
}

/* ── 年视图：12 个月热力概览 ────────────────────────────── */

function YearView({ date, onPick }: { date: string; onPick: (date: string) => void }) {
  const days = usePlans((s) => s.days);
  const archive = usePlansArchive((s) => s.days);
  const year = parseDate(date).getFullYear();
  const [hover, setHover] = useState<string | null>(null);

  const months = useMemo(() => Array.from({ length: 12 }, (_, month) => {
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const cells = Array.from({ length: 42 }, (_, i) => {
      const d = new Date(year, month, 1 - offset + i);
      const cell = fmtDate(d);
      const tasks = days[cell] ?? archive[cell]?.tasks ?? [];
      return { date: cell, inMonth: d.getMonth() === month, count: tasks.length, done: tasks.filter((task) => task.done).length };
    });
    return { month, label: new Intl.DateTimeFormat(undefined, { month: "short" }).format(first), cells };
  }), [year, days, archive]);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {months.map(({ month, label, cells }) => (
        <div key={month} className="rounded-xl border border-border p-2">
          <p className="mb-1 text-[11px] font-semibold text-muted-foreground">{label}</p>
          <div className="grid grid-cols-7 gap-px">
            {cells.map((cell) => {
              // 热度：任务越多颜色越深；全完成用 success 色区分
              const ratio = cell.count === 0 ? 0 : cell.done / cell.count;
              const intensity = Math.min(cell.count, 4) / 4;
              return (
                <button key={cell.date} type="button" onClick={() => onPick(cell.date)}
                  onMouseEnter={() => setHover(`${cell.date} · ${cell.count}`)}
                  onMouseLeave={() => setHover(null)}
                  title={`${cell.date}${cell.count ? ` · ${cell.done}/${cell.count}` : ""}`}
                  className={cn(
                    "aspect-square rounded-[2px] transition-transform hover:scale-125",
                    !cell.inMonth && "opacity-25",
                    cell.count === 0 && "bg-muted/40",
                    cell.count > 0 && ratio === 1 && "bg-success/70",
                    cell.count > 0 && ratio < 1 && "bg-brand",
                  )}
                  style={cell.count > 0 && ratio < 1 ? { opacity: 0.35 + intensity * 0.65 } : undefined}
                />
              );
            })}
          </div>
        </div>
      ))}
      <p className="col-span-full text-center text-[11px] text-muted-foreground">{hover ?? ""}</p>
    </div>
  );
}
