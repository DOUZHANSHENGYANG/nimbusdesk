import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Clock, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { fmtMinutes, hasRange, minutesOf, rangeDuration } from "@/features/plans/types";

/**
 * 时间范围选择器：时/分 两列下拉，而不是自由文本输入。
 *
 * 为什么不用 <input type="time">：WebView2 下它渲染成浏览器原生的时钟控件，
 * 与本应用「无原生控件」的设计约束冲突（弹窗/菜单都是自绘的）。
 *
 * 为什么不用 Select：24 个小时 + 12 个分钟若用两个 Select 叠加，
 * 在弹窗里层级与宽度都难控；一个 Popover 内放两列滚动列表更紧凑。
 */

/** 分钟只给 5 的倍数，避免 60 项过长 */
const MINUTE_STEP = 5;

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => i * MINUTE_STEP);

/** "HH:mm" → {h, m}；非法或空返回 null 两端 */
function split(hhmm?: string): { h: number | null; m: number | null } {
  const v = minutesOf(hhmm);
  if (v == null) return { h: null, m: null };
  return { h: Math.floor(v / 60), m: v % 60 };
}

const DAY_END = 23 * 60 + 59;

/** 一列（时 或 分），点选即回填 */
function Column({
  values,
  selected,
  onPick,
}: {
  values: number[];
  selected: number | null;
  onPick: (v: number) => void;
}) {
  return (
    <div className="flex max-h-52 w-14 flex-col overflow-y-auto pr-0.5">
      {values.map((v) => {
        const active = selected === v;
        return (
          <button
            key={v}
            type="button"
            onClick={() => onPick(v)}
            className={cn(
              "shrink-0 rounded-md py-1 text-center font-mono text-[12px] tabular-nums transition-colors",
              active
                ? "bg-brand text-white"
                : "text-foreground/80 hover:bg-muted hover:text-foreground",
            )}
          >
            {String(v).padStart(2, "0")}
          </button>
        );
      })}
    </div>
  );
}

export function TimeRangePicker({
  start,
  end,
  onChange,
  className,
}: {
  start?: string;
  end?: string;
  /** 传 undefined 表示清空该端 */
  onChange: (next: { start?: string; end?: string }) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const s = split(start);
  const e = split(end);
  const valid = hasRange({ start, end });
  const dur = rangeDuration({ start, end });

  const label = useMemo(() => {
    if (start && end) return `${start} – ${end}`;
    if (start) return `${start} – …`;
    return t("plans.pickTimeRange");
  }, [start, end, t]);

  const clear = () => onChange({ start: undefined, end: undefined });

  /** 改开始时间：若越过结束时间，把结束一起推后一小时 */
  const setStart = (h: number | null, m: number | null) => {
    const hh = h ?? s.h ?? 9;
    const mm = m ?? s.m ?? 0;
    const next = fmtMinutes(hh * 60 + mm);
    const nextMin = minutesOf(next)!;
    const endMin = minutesOf(end);
    if (endMin != null && nextMin >= endMin) {
      onChange({ start: next, end: fmtMinutes(Math.min(nextMin + 60, DAY_END)) });
    } else {
      onChange({ start: next, end });
    }
  };

  /** 改结束时间：若早于开始时间，把开始一起提前一小时 */
  const setEnd = (h: number | null, m: number | null) => {
    const hh = h ?? e.h ?? 10;
    const mm = m ?? e.m ?? 0;
    const next = fmtMinutes(hh * 60 + mm);
    const nextMin = minutesOf(next)!;
    const startMin = minutesOf(start);
    if (startMin != null && nextMin <= startMin) {
      onChange({ start: fmtMinutes(Math.max(nextMin - 60, 0)), end: next });
    } else {
      onChange({ start, end: next });
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-[12px] transition-colors hover:border-brand/50",
            valid ? "text-foreground" : "text-muted-foreground/70",
            className,
          )}
        >
          <Clock className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-mono tabular-nums">{label}</span>
          {(start || end) && (
            <span
              role="button"
              tabIndex={0}
              title={t("plans.clearTime")}
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

      <PopoverContent align="start" className="w-auto p-2.5">
        <div className="flex gap-2.5">
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("plans.timeStart")}
            </span>
            <div className="flex gap-1">
              <Column values={HOURS} selected={s.h} onPick={(h) => setStart(h, null)} />
              <Column values={MINUTES} selected={s.m} onPick={(m) => setStart(null, m)} />
            </div>
          </div>

          <div className="w-px bg-border" />

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("plans.timeEnd")}
            </span>
            <div className="flex gap-1">
              <Column values={HOURS} selected={e.h} onPick={(h) => setEnd(h, null)} />
              <Column values={MINUTES} selected={e.m} onPick={(m) => setEnd(null, m)} />
            </div>
          </div>
        </div>

        {/* 快捷时长：常见场景一键到位 */}
        <div className="mt-2 flex items-center gap-1.5 border-t border-border/60 pt-2">
          {[30, 60, 90, 120].map((mins) => (
            <button
              key={mins}
              type="button"
              onClick={() => {
                const base = minutesOf(start) ?? 9 * 60;
                onChange({
                  start: fmtMinutes(base),
                  end: fmtMinutes(Math.min(base + mins, DAY_END)),
                });
              }}
              className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {mins >= 60
                ? t("plans.hoursShort", { n: mins / 60 })
                : t("plans.minutesShort", { n: mins })}
            </button>
          ))}
          {dur != null && (
            <span className="ml-auto font-mono text-[11px] text-muted-foreground/70">
              {dur >= 60
                ? t("plans.hoursShort", { n: (dur / 60).toFixed(dur % 60 ? 1 : 0) })
                : t("plans.minutesShort", { n: dur })}
            </span>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
