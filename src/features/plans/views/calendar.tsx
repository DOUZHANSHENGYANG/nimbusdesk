import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { dayProgress, fmtDate, parseDate, todayStr } from "@/features/plans/types";
import { usePlans, usePlansArchive } from "@/features/plans/store";
import { cn } from "@/lib/utils";

export type CalendarNav = { onPick: (date: string) => void };

/** 日历月视图：整月网格 + 每日进度 + 点选日期 */
export function CalendarView({ date, onPick }: { date: string; onPick: (date: string) => void }) {
  const { t, i18n } = useTranslation();
  const days = usePlans((s) => s.days);
  const archiveDays = usePlansArchive((s) => s.days);
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

  /* 日历在大屏下会被拉得很扁，限制宽度并居中，保持单元格比例 */
  return (
    <div className="mx-auto w-full max-w-2xl">
      {/* 月导航 */}
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => shift(-1)}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="text-[14px] font-semibold">{monthLabel}</span>
        <button
          type="button"
          onClick={() => shift(1)}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>

      {/* 星期表头 */}
      <div className="mb-1 grid grid-cols-7 gap-1">
        {weekdayLabels.map((w) => (
          <div key={w} className="py-1 text-center text-[11px] font-medium text-muted-foreground">
            {w}
          </div>
        ))}
      </div>

      {/* 日期网格 */}
      <div className="grid grid-cols-7 gap-1">
        {grid.map(({ date: cell, inMonth }) => {
          const active = days[cell];
          const archived = archiveDays[cell];
          const progress = active ? dayProgress(active) : null;
          const archProgress = archived ? dayProgress(archived.tasks) : null;
          const count = progress?.total ?? archProgress?.total ?? 0;
          const doneCount = progress?.done ?? archProgress?.done ?? 0;
          const isSelected = cell === date;
          const isToday = cell === today;

          return (
            <button
              key={cell}
              type="button"
              onClick={() => onPick(cell)}
              className={cn(
                "relative flex h-16 flex-col items-center justify-start gap-1 rounded-lg border p-1.5 transition-colors duration-150",
                inMonth ? "border-border" : "border-transparent opacity-40",
                isSelected
                  ? "border-brand bg-brand/10"
                  : "hover:border-muted-foreground/40 hover:bg-surface-hover",
              )}
            >
              <span
                className={cn(
                  "text-[12px] font-medium",
                  isToday && "grid size-5 place-items-center rounded-full bg-brand text-white",
                )}
              >
                {parseDate(cell).getDate()}
              </span>

              {count > 0 && (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[10px] font-medium",
                    archProgress
                      ? "bg-muted text-muted-foreground"
                      : doneCount === count
                        ? "bg-success/15 text-success"
                        : "bg-brand/10 text-brand",
                  )}
                >
                  {doneCount}/{count}
                  {archProgress != null && ` ${t("plans.archived")}`}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
