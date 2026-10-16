import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  dayProgress,
  fmtDate,
  parseDate,
  statusOf,
  todayStr,
  type PlanTask,
} from "@/features/plans/types";
import { useNow, usePlans, usePlansArchive } from "@/features/plans/store";
import { cn } from "@/lib/utils";

export type CalendarNav = { onPick: (date: string) => void };

/** 每个日期格最多列几条任务名，超出显示 +N */
const MAX_CHIPS = 3;

/** 日历月视图：整月网格 + 任务名 + 每日进度 + 点选日期 */
export function CalendarView({ date, onPick }: { date: string; onPick: (date: string) => void }) {
  const { t, i18n } = useTranslation();
  const days = usePlans((s) => s.days);
  const archiveDays = usePlansArchive((s) => s.days);
  const now = useNow();
  const today = todayStr();

  const [monthAnchor, setMonthAnchor] = useState(() => {
    const d = parseDate(date);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  const grid = useMemo(() => {
    const first = new Date(monthAnchor.y, monthAnchor.m, 1);
    const startOffset = (first.getDay() + 6) % 7; // 周一为首
    const start = new Date(monthAnchor.y, monthAnchor.m, 1 - startOffset);
    const cells: { date: string; inMonth: boolean }[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      cells.push({ date: fmtDate(d), inMonth: d.getMonth() === monthAnchor.m });
    }
    return cells;
  }, [monthAnchor]);

  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.language === "en" ? "en-US" : "zh-CN", {
      weekday: "short",
    });
    // 2024-01-01 是周一
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
  }, [i18n.language]);

  const monthLabel = new Intl.DateTimeFormat(i18n.language === "en" ? "en-US" : "zh-CN", {
    year: "numeric",
    month: "long",
  }).format(new Date(monthAnchor.y, monthAnchor.m, 1));

  const shift = (delta: number) => {
    const d = new Date(monthAnchor.y, monthAnchor.m + delta, 1);
    setMonthAnchor({ y: d.getFullYear(), m: d.getMonth() });
  };

  return (
    <div className="mx-auto w-full max-w-5xl">
      {/* 月导航 */}
      <div className="mb-3 flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => shift(-1)}
          className="grid size-7 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:border-brand/40 hover:text-brand"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="min-w-36 text-center text-[14px] font-semibold">{monthLabel}</span>
        <button
          type="button"
          onClick={() => shift(1)}
          className="grid size-7 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:border-brand/40 hover:text-brand"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>

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
