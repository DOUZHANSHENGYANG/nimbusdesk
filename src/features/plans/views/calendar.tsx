import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  addDays,
  dayProgress,
  fmtDate,
  monthGrid,
  parseDate,
  statusOf,
  todayStr,
  type PlanTask,
} from "@/features/plans/types";
import { useNow, usePlans, usePlansArchive } from "@/features/plans/store";
import { cn } from "@/lib/utils";
import { ScheduleView } from "./schedule";
import { PlansRail } from "./plans-rail";

export type CalendarNav = { onPick: (date: string) => void };
/** 每个日期格最多列几条任务名，超出显示 +N */
const MAX_CHIPS = 3;
/** 日程档位：日 / 周 / 月 / 年 */
export type CalendarScale = "day" | "week" | "month" | "year";

/** 日历容器：日/周/月/年四档，共用一套导航（上一页 / 今天 / 下一页 + 档位切换） */
export function CalendarView({ date, onPick }: { date: string; onPick: (date: string) => void }) {
  const { t, i18n } = useTranslation();
  const [scale, setScale] = useState<CalendarScale>("month");
  const [anchor, setAnchor] = useState(date);

  const shift = (delta: number) => {
    const d = parseDate(anchor);
    if (scale === "day") return setAnchor(fmtDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta)));
    if (scale === "week") return setAnchor(fmtDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta * 7)));
    if (scale === "year") return setAnchor(fmtDate(new Date(d.getFullYear() + delta, d.getMonth(), d.getDate())));
    setAnchor(fmtDate(new Date(d.getFullYear(), d.getMonth() + delta, d.getDate())));
  };

  const title = useMemo(() => {
    const d = parseDate(anchor);
    const locale = i18n.language === "en" ? "en-US" : "zh-CN";
    if (scale === "year") return new Intl.DateTimeFormat(locale, { year: "numeric" }).format(d);
    if (scale === "month") return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(d);
    if (scale === "day") return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" }).format(d);
    const start = parseDate(weekStart(anchor));
    const end = parseDate(addDays(weekStart(anchor), 6));
    const fmt = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" });
    return `${fmt.format(start)} – ${fmt.format(end)}`;
  }, [anchor, scale, i18n.language]);

  const scales: { key: CalendarScale; label: string }[] = [
    { key: "day", label: t("plans.scaleDay") },
    { key: "week", label: t("plans.scaleWeek") },
    { key: "month", label: t("plans.scaleMonth") },
    { key: "year", label: t("plans.scaleYear") },
  ];

  return (
    <div className="w-full">
      {/* 导航：上一页 / 标题 / 下一页 / 今天 + 档位切换 */}
      <div className="mb-3 flex flex-wrap items-center justify-center gap-2">
        <button type="button" onClick={() => shift(-1)}
          aria-label={t("plans.prevPage")}
          className="grid size-7 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:border-brand/40 hover:text-brand">
          <ChevronLeft className="size-4" />
        </button>
        <span className="min-w-40 text-center text-[14px] font-semibold">{title}</span>
        <button type="button" onClick={() => shift(1)}
          aria-label={t("plans.nextPage")}
          className="grid size-7 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:border-brand/40 hover:text-brand">
          <ChevronRight className="size-4" />
        </button>
        <button type="button" onClick={() => { setAnchor(todayStr()); onPick(todayStr()); }}
          className="rounded-lg border border-border bg-card px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:border-brand/40 hover:text-brand">
          {t("plans.today")}
        </button>
        <span className="ml-1 inline-flex rounded-lg border border-border bg-card p-0.5">
          {scales.map(({ key, label }) => (
            <button key={key} type="button" aria-pressed={scale === key} onClick={() => setScale(key)}
              className={cn(
                "rounded-md px-2 py-0.5 text-[12px] transition-colors",
                scale === key ? "bg-brand text-white" : "text-muted-foreground hover:text-foreground",
              )}>
              {label}
            </button>
          ))}
        </span>
      </div>

      {/* 栅格铺满（不再夹在 1024px 里），右侧一列玻璃栏 */}
      <div className="flex gap-5">
        <div className="min-w-0 flex-1">
          {scale === "month"
            ? <MonthGrid date={anchor} onPick={onPick} />
            : <ScheduleView date={anchor} mode={scale} onPick={(cell) => { setAnchor(cell); onPick(cell); }} />}
        </div>
        <PlansRail />
      </div>
    </div>
  );
}

function weekStart(dateStr: string): string {
  const d = parseDate(dateStr);
  const offset = (d.getDay() + 6) % 7;
  return fmtDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset));
}

/** 月档：整月网格 + 任务名 + 每日进度 + 点选日期 */
function MonthGrid({ date, onPick }: { date: string; onPick: (date: string) => void }) {
  const { t, i18n } = useTranslation();
  const days = usePlans((s) => s.days);
  const archiveDays = usePlansArchive((s) => s.days);
  const now = useNow();
  const today = todayStr();

  const anchorMonth = useMemo(() => {
    const d = parseDate(date);
    return { y: d.getFullYear(), m: d.getMonth() };
  }, [date]);

  const grid = useMemo(() => monthGrid(anchorMonth.y, anchorMonth.m), [anchorMonth]);

  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.language === "en" ? "en-US" : "zh-CN", {
      weekday: "short",
    });
    // 2024-01-01 是周一
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
  }, [i18n.language]);

  return (
    <div>
      {/* 星期表头 */}
      <div className="mb-1.5 grid grid-cols-7 gap-1.5">
        {weekdayLabels.map((w) => (
          <div key={w} className="py-1 text-center text-[11px] font-medium text-muted-foreground">
            {w}
          </div>
        ))}
      </div>

      {/* 日期网格 */}
      <div className="grid grid-cols-7 gap-1.5">
        {grid.map(({ date: cell, inMonth }) => {
          const active = days[cell];
          const archived = archiveDays[cell];
          const tasks: PlanTask[] = active ?? archived?.tasks ?? [];
          const progress = tasks.length > 0 ? dayProgress(tasks) : null;
          const isArchived = archived != null && active == null;
          const isSelected = cell === date;
          const isToday = cell === today;
          const shown = tasks.slice(0, MAX_CHIPS);
          const rest = tasks.length - shown.length;

          return (
            <button
              key={cell}
              type="button"
              onClick={() => onPick(cell)}
              className={cn(
                "flex min-h-24 flex-col items-stretch gap-1 rounded-xl border p-1.5 text-left transition-colors duration-150",
                inMonth ? "border-border" : "border-transparent opacity-40",
                isSelected
                  ? "border-brand bg-brand/10"
                  : "hover:border-muted-foreground/40 hover:bg-surface-hover",
              )}
            >
              {/* 日期 + 进度 */}
              <div className="flex items-center justify-between gap-1">
                <span
                  className={cn(
                    "text-[12px] font-semibold",
                    isToday && "grid size-5 place-items-center rounded-full bg-brand text-white",
                    !isToday && !inMonth && "text-muted-foreground",
                  )}
                >
                  {parseDate(cell).getDate()}
                </span>
                {progress && progress.total > 0 && (
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-1.5 text-[10px] font-medium tabular-nums",
                      isArchived
                        ? "bg-muted text-muted-foreground"
                        : progress.done === progress.total
                          ? "bg-success/15 text-success"
                          : "bg-brand/10 text-brand",
                    )}
                  >
                    {progress.done}/{progress.total}
                  </span>
                )}
              </div>

              {/* 任务名：单行截断，不换行（格子高度固定，换行会撑破网格） */}
              <div className="flex min-w-0 flex-col gap-0.5">
                {shown.map((task) => {
                  const status = statusOf(task, cell, now);
                  return (
                    <span
                      key={task.id}
                      title={task.title}
                      className={cn(
                        "block w-full truncate rounded px-1 py-px text-[10px] leading-4",
                        status === "done"
                          ? "bg-muted/60 text-muted-foreground line-through"
                          : status === "doing"
                            ? "bg-brand text-white"
                            : "bg-muted text-foreground/80",
                      )}
                    >
                      {task.title}
                    </span>
                  );
                })}
                {rest > 0 && (
                  <span className="px-1 text-[10px] text-muted-foreground">
                    {t("plans.moreTasks", { count: rest })}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
