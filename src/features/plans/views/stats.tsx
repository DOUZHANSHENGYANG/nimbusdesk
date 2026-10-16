import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BarChart3, Flame, CalendarRange, Clock, ListChecks } from "lucide-react";
import { addDays, todayStr } from "@/features/plans/types";
import { usePlans, usePlansArchive, useNow } from "@/features/plans/store";
import {
  completionStreak,
  mergeDayMaps,
  rangeStats,
  schedulingCoverage,
  statusBreakdown,
  weekdayStats,
  weeklyTrend,
  type DayMap,
} from "@/features/plans/stats";
import { cn } from "@/lib/utils";

/**
 * 统计视图。
 *
 * 数据窗口 = **当前选中日往前 N 天**，所以它仍然只吃 `{date}`，
 * 与大纲/时间轴/看板/日历保持同一个接口契约（加视图不破坏其它视图）。
 *
 * 图表全部是纯 CSS（`conic-gradient` 环形 / flex 柱状），不引入图表库 ——
 * 这几个图形的复杂度远低于一个库的体积与版本风险。
 */

type RangeKey = "7" | "30" | "90";
const RANGE_DAYS: Record<RangeKey, number> = { "7": 7, "30": 30, "90": 90 };

/** 全 0 环形用的兜底色（不显示成「100% 完成」） */
const EMPTY_RING = "var(--muted)";

export function StatsView({ date }: { date: string }) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const [range, setRange] = useState<RangeKey>("30");

  const active = usePlans((s) => s.days);
  const archived = usePlansArchive((s) => s.days);

  // 活跃库 + 归档库合并：统计要跨库才有意义（过期日已自动归档）
  const days: DayMap = useMemo(() => mergeDayMaps(active, archived), [active, archived]);

  const span = RANGE_DAYS[range];
  const from = addDays(date, -(span - 1));
  const stats = useMemo(() => rangeStats(days, from, date), [days, from, date]);
  const trend = useMemo(() => weeklyTrend(days, date, Math.ceil(span / 7)), [days, date, span]);
  const weekdays = useMemo(() => weekdayStats(days, from, date), [days, from, date]);
  const coverage = useMemo(() => schedulingCoverage(days, from, date), [days, from, date]);
  const today = useMemo(() => statusBreakdown(days, date, now), [days, date, now]);
  const streak = useMemo(() => completionStreak(days, todayStr()), [days]);

  const locale = i18n.language === "en" ? "en-US" : "zh-CN";
  const fmtShort = (d: string) =>
    new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(
      new Date(`${d}T00:00:00`),
    );

  const hasAny = stats.total > 0;

  return (
    <div className="flex flex-col gap-4">
      {/* ── 窗口选择 ── */}
      <div className="flex items-center gap-2">
        <div className="flex w-fit items-center gap-0.5 rounded-xl border border-border bg-muted/40 p-1">
          {(Object.keys(RANGE_DAYS) as RangeKey[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setRange(k)}
              className={cn(
                "rounded-lg px-3 py-1 text-[12px] font-medium transition-colors duration-150",
                range === k
                  ? "bg-card text-foreground shadow-[var(--pr-shadow-1)] ring-1 ring-border"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("plans.stats.rangeDays", { count: RANGE_DAYS[k] })}
            </button>
          ))}
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">
          {fmtShort(from)} – {fmtShort(date)}
        </span>
      </div>

      {!hasAny ? (
        <p className="py-10 text-center text-[13px] text-muted-foreground">
          {t("plans.stats.noData")}
        </p>
      ) : (
        <>
          {/* ── 概览数字卡 ── */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              icon={<ListChecks className="size-4" />}
              label={t("plans.stats.totalTasks")}
              value={String(stats.total)}
              hint={t("plans.stats.doneOf", { done: stats.done })}
            />
            <StatCard
              icon={<CalendarRange className="size-4" />}
              label={t("plans.stats.activeDays")}
              value={String(stats.daysWithTasks)}
              hint={t("plans.stats.emptyDays", { count: stats.emptyDays })}
            />
            <StatCard
              icon={<Clock className="size-4" />}
              label={t("plans.stats.scheduledRate")}
              value={coverage.rate == null ? "—" : `${Math.round(coverage.rate * 100)}%`}
              hint={t("plans.stats.scheduledOf", {
                scheduled: coverage.scheduled,
                unscheduled: coverage.unscheduled,
              })}
            />
            <StatCard
              icon={<Flame className="size-4" />}
              label={t("plans.stats.streak")}
              value={String(streak)}
              hint={t("plans.stats.streakUnit")}
            />
          </div>

          {/* ── 完成率 + 状态分布 ── */}
          <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
            <Card title={t("plans.stats.completionRate")}>
              <div className="flex items-center gap-4">
                <Ring rate={stats.rate} />
                <div className="flex flex-col gap-1.5 text-[12px]">
                  <Legend color="var(--brand)" label={t("plans.status.done")} value={stats.done} />
                  <Legend
                    color="var(--muted-foreground)"
                    label={t("plans.status.todo")}
                    value={stats.total - stats.done}
                  />
                  {stats.perActiveDay != null && (
                    <span className="mt-1 text-[11px] text-muted-foreground">
                      {t("plans.stats.perActiveDay", {
                        n: stats.perActiveDay.toFixed(1),
                      })}
                    </span>
                  )}
                </div>
              </div>
            </Card>

            <Card title={t("plans.stats.todayStatus", { date: fmtShort(date) })}>
              <div className="flex flex-col gap-2">
                {(["doing", "todo", "done"] as const).map((k) => (
                  <Bar
                    key={k}
                    label={t(`plans.status.${k}`)}
                    value={today[k]}
                    total={today.todo + today.doing + today.done}
                    color={
                      k === "done"
                        ? "var(--brand)"
                        : k === "doing"
                          ? "var(--success, var(--brand))"
                          : "var(--muted-foreground)"
                    }
                  />
                ))}
              </div>
            </Card>
          </div>

          {/* ── 周趋势 ── */}
          <Card
            title={t("plans.stats.weeklyTrend")}
            icon={<BarChart3 className="size-4 text-brand" />}
          >
            <WeeklyTrendChart
              buckets={trend}
              fmt={fmtShort}
              label={(b) => t("plans.stats.weekOf", { date: fmtShort(b.from) })}
              emptyLabel={t("plans.stats.noneShort")}
            />
          </Card>

          {/* ── 星期分布 ── */}
          <Card title={t("plans.stats.byWeekday")}>
            <div className="flex flex-col gap-1.5">
              {weekdays.map((w) => (
                <div key={w.weekday} className="flex items-center gap-3">
                  <span className="w-8 shrink-0 text-[11px] text-muted-foreground">
                    {t(`plans.stats.weekday.${w.weekday}`)}
                  </span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-brand/80 transition-[width] duration-300"
                      style={{ width: `${(w.rate ?? 0) * 100}%` }}
                    />
                  </span>
                  <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                    {w.total === 0 ? "—" : `${w.done}/${w.total}`}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          {/* ── 未定时任务提醒 ── */}
          {coverage.unscheduled > 0 && (
            <Card title={t("plans.stats.unscheduled")}>
              <p className="text-[12px] text-muted-foreground">
                {t("plans.stats.unscheduledHint", { count: coverage.unscheduled })}
              </p>
              <div className="mt-2 flex flex-col gap-1">
                {coverage.samples.map((title, i) => (
                  <span key={i} className="truncate text-[12px] text-foreground/80">
                    · {title}
                  </span>
                ))}
                {coverage.unscheduled > coverage.samples.length && (
                  <span className="text-[11px] text-muted-foreground">
                    {t("plans.stats.andMore", {
                      count: coverage.unscheduled - coverage.samples.length,
                    })}
                  </span>
                )}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

/* ── 展示件 ───────────────────────────────────────────── */

function Card({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <h3 className="flex items-center gap-2 text-[13px] font-semibold text-foreground/90">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-3.5">
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <span className="text-brand">{icon}</span>
        {label}
      </span>
      <span className="text-[22px] font-semibold leading-tight tabular-nums text-foreground">
        {value}
      </span>
      <span className="truncate text-[11px] text-muted-foreground" title={hint}>
        {hint}
      </span>
    </div>
  );
}

/** 环形进度。rate=null（无任务）时画一圈灰环，而不是空环或满环 */
function Ring({ rate }: { rate: number | null }) {
  const pct = rate == null ? 0 : Math.round(rate * 100);
  const bg =
    rate == null
      ? EMPTY_RING
      : `conic-gradient(var(--brand) 0% ${pct}%, var(--muted) ${pct}% 100%)`;
  return (
    <div
      className="relative grid size-20 shrink-0 place-items-center rounded-full"
      style={{ background: bg }}
    >
      <div className="grid size-15 place-items-center rounded-full bg-card">
        <span className="text-[15px] font-semibold tabular-nums text-foreground">
          {rate == null ? "—" : `${pct}%`}
        </span>
      </div>
    </div>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <span className="flex items-center gap-2">
      <span className="size-2 rounded-full" style={{ background: color }} />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums text-foreground">{value}</span>
    </span>
  );
}

function Bar({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full transition-[width] duration-300"
          style={{ width: `${pct}%`, background: color }}
        />
      </span>
      <span className="w-6 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {value}
      </span>
    </div>
  );
}

/**
 * 周趋势柱状。
 *
 * 高度 = 完成率，柱内实心部分 = 已完成条数占比。
 * 空周（total=0）画一条 2px 的基线而不是 0 高柱子 ——
 * 「这周没安排」与「安排了没做」在视觉上必须能分开。
 */
function WeeklyTrendChart({
  buckets,
  fmt,
  label,
  emptyLabel,
}: {
  buckets: { from: string; to: string; total: number; done: number; rate: number | null }[];
  fmt: (d: string) => string;
  label: (b: { from: string; to: string }) => string;
  emptyLabel: string;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.total));
  return (
    <div className="flex items-end gap-2">
      {buckets.map((b) => {
        const empty = b.total === 0;
        const h = empty ? 2 : Math.max(6, (b.total / max) * 84);
        const doneH = empty ? 0 : (b.done / b.total) * h;
        return (
          <div key={b.from} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {empty ? "—" : `${b.done}/${b.total}`}
            </span>
            <div
              className="relative w-full max-w-10 overflow-hidden rounded-md bg-muted"
              style={{ height: h }}
              title={`${label(b)} · ${empty ? emptyLabel : `${b.done}/${b.total}`}`}
            >
              {doneH > 0 && (
                <span
                  className="absolute bottom-0 left-0 w-full rounded-md bg-brand"
                  style={{ height: doneH }}
                />
              )}
            </div>
            <span className="truncate text-[10px] text-muted-foreground">{fmt(b.from)}</span>
          </div>
        );
      })}
    </div>
  );
}
