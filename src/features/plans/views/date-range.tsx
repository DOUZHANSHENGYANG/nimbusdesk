import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  inRange,
  monthBounds,
  monthGrid,
  parseDate,
  presetRange,
  rangeDays,
  todayStr,
  type DateRange,
} from "@/features/plans/types";

/**
 * 日期区间选择器：点两个端点即选定 from–to。
 *
 * 为什么自建而不是用 react-day-picker / 原生 <input type="date">：
 * - 本项目未引入任何日历库（package.json 里没有 date-fns/dayjs/react-day-picker）
 * - <input type="date"> 在 WebView2 下弹出浏览器原生日期控件，
 *   与「无原生控件」的设计约束冲突
 * 网格计算复用 types.ts 的 monthGrid()，与计划日历视图同一套逻辑。
 */

type Preset = "today" | "week" | "month" | "last7" | "last30";
const PRESETS: Preset[] = ["today", "week", "month", "last7", "last30"];

export function DateRangePicker({
  value,
  onChange,
  className,
  /** 快捷区间「本周/本月」等相对今天计算；测试可注入 */
  now,
}: {
  value: DateRange;
  onChange: (next: DateRange) => void;
  className?: string;
  now?: Date;
}) {
  const { t, i18n } = useTranslation();
  const today = todayStr();
  const [open, setOpen] = useState(false);
  /** 正在选第几个端点：null = 未开始（下次点击设 from） */
  const [picking, setPicking] = useState<"from" | "to" | null>(null);
  const [anchor, setAnchor] = useState(() => {
    const d = value.from ? parseDate(value.from) : new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  const grid = useMemo(() => monthGrid(anchor.y, anchor.m), [anchor]);

  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.language === "en" ? "en-US" : "zh-CN", {
      weekday: "narrow",
    });
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
  }, [i18n.language]);

  const monthLabel = new Intl.DateTimeFormat(i18n.language === "en" ? "en-US" : "zh-CN", {
    year: "numeric",
    month: "long",
  }).format(new Date(anchor.y, anchor.m, 1));

  const shift = (delta: number) => {
    const d = new Date(anchor.y, anchor.m + delta, 1);
    setAnchor({ y: d.getFullYear(), m: d.getMonth() });
  };

  /** 点某一天：第一次设 from 并等待 to；第二次设 to 并关闭 */
  const pickDay = (day: string) => {
    if (picking === null) {
      onChange({ from: day, to: null });
      setPicking("to");
      return;
    }
    if (picking === "to") {
      // 反向点选（终点早于起点）时自动交换，避免出现空区间
      if (value.from && day < value.from) {
        onChange({ from: day, to: value.from });
      } else {
        onChange({ from: value.from, to: day });
      }
      setPicking(null);
      setOpen(false);
      return;
    }
    onChange({ from: day, to: null });
    setPicking("to");
  };

  /** 切月时顺手把「整月」设为区间（常用：按归档月份筛选） */
  const pickWholeMonth = () => {
    onChange(monthBounds(anchor.y, anchor.m));
    setPicking(null);
    setOpen(false);
  };

  const days = rangeDays(value);
  const label = useMemo(() => {
    if (value.from && value.to) {
      if (value.from === value.to) return value.from;
      return `${value.from} → ${value.to}`;
    }
    if (value.from) return `${value.from} → …`;
    return t("plans.pickDateRange");
  }, [value.from, value.to, t]);

  const clear = () => {
    onChange({ from: null, to: null });
    setPicking(null);
  };

  const active = value.from != null || value.to != null;

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setPicking(null); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[12px] transition-colors",
            active
              ? "border-brand/40 bg-brand/5 text-foreground"
              : "border-border bg-card text-muted-foreground hover:border-brand/40 hover:text-brand",
            className,
          )}
        >
          <CalendarDays className="size-3.5 shrink-0" />
          <span className="font-mono tabular-nums">{label}</span>
          {days != null && (
            <span className="shrink-0 text-muted-foreground/70">
              {t("plans.daysCount", { count: days })}
            </span>
          )}
          {active && (
            <span
              role="button"
              tabIndex={0}
              title={t("plans.clearRange")}
              onClick={(ev) => {
                ev.stopPropagation();
                clear();
              }}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.stopPropagation();
                  clear();
                }
              }}
              className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground"
            >
              <X className="size-3" />
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-auto p-3">
        {/* 快捷区间 */}
        <div className="mb-2.5 flex flex-wrap items-center gap-1">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                onChange(presetRange(p, now));
                setPicking(null);
                setOpen(false);
              }}
              className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-brand/40 hover:text-brand"
            >
              {t(`plans.presets.${p}`)}
            </button>
          ))}
        </div>

        {/* 月导航 */}
        <div className="mb-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => shift(-1)}
            className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <span className="text-[12px] font-semibold">{monthLabel}</span>
          <button
            type="button"
            onClick={() => shift(1)}
            className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>

        {/* 星期表头 */}
        <div className="mb-0.5 grid grid-cols-7 gap-0.5">
          {weekdayLabels.map((w, i) => (
            <div
              key={i}
              className="py-0.5 text-center text-[10px] font-medium text-muted-foreground"
            >
              {w}
            </div>
          ))}
        </div>

        {/* 日期网格 */}
        <div className="grid grid-cols-7 gap-0.5">
          {grid.map(({ date: day, inMonth }) => {
            const isFrom = value.from === day;
            const isTo = value.to === day;
            const isEdge = isFrom || isTo;
            const between = value.from != null && value.to != null && inRange(day, value);
            const isToday = day === today;

            return (
              <button
                key={day}
                type="button"
                onClick={() => pickDay(day)}
                className={cn(
                  "grid size-7 place-items-center rounded-md text-[11px] tabular-nums transition-colors",
                  !inMonth && "opacity-35",
                  isEdge
                    ? "bg-brand font-semibold text-white"
                    : between
                      ? "bg-brand/15 text-brand"
                      : "hover:bg-muted",
                  isToday && !isEdge && "ring-1 ring-inset ring-brand/50",
                )}
              >
                {parseDate(day).getDate()}
              </button>
            );
          })}
        </div>

        {/* 底部：整月 + 提示 */}
        <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
          <button
            type="button"
            onClick={pickWholeMonth}
            className="rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t("plans.wholeMonth")}
          </button>
          <span className="text-[11px] text-muted-foreground/70">
            {picking === "to" ? t("plans.pickRangeEnd") : t("plans.pickRangeStart")}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
