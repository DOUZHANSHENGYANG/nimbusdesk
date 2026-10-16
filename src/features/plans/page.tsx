import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Archive } from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  addDays,
  dayProgress,
  parseDate,
  todayStr,
} from "@/features/plans/types";
import { useDayTasks, usePlans, usePlansArchive, archiveDay, autoArchivePastDays } from "@/features/plans/store";
import { OutlineView } from "@/features/plans/views/outline";
import { KanbanView } from "@/features/plans/views/kanban";
import { TimelineView } from "@/features/plans/views/timeline";
import { CalendarView } from "@/features/plans/views/calendar";
import { ArchiveView } from "@/features/plans/views/archive";
import { useModal } from "@/components/shell/modal-host";
import { gsap, useGSAP } from "@/lib/gsap";
import { cn } from "@/lib/utils";

type ViewKey = "outline" | "timeline" | "kanban" | "calendar" | "archive";
const VIEW_KEYS: ViewKey[] = ["outline", "timeline", "kanban", "calendar", "archive"];

/** persist 水合完成（响应式） */
function useStoreHydrated(store: typeof usePlans | typeof usePlansArchive): boolean {
  const [h, setH] = useState(() => store.persist.hasHydrated());
  useEffect(() => {
    if (store.persist.hasHydrated()) {
      setH(true);
      return;
    }
    return store.persist.onFinishHydration(() => setH(true));
  }, [store]);
  return h;
}

/** 计划管理：日期导航 + 五视图切换 + 自动/手动归档 */
export function PlansPage() {
  const { t, i18n } = useTranslation();
  const { confirm } = useModal();
  const [date, setDate] = useState(todayStr());
  const [view, setView] = useState<ViewKey>("outline");
  const [viewTick, setViewTick] = useState(0); // 视图切换动画 key

  const plansHydrated = useStoreHydrated(usePlans);
  const archiveHydrated = useStoreHydrated(usePlansArchive);
  const tasks = useDayTasks(date);
  const isArchivedDay = usePlansArchive((s) => date in s.days);

  const bodyRef = useRef<HTMLDivElement>(null);

  // 自动归档过期日
  useEffect(() => {
    if (!plansHydrated || !archiveHydrated) return;
    const n = autoArchivePastDays();
    if (n > 0) toast.success(`${t("plans.archived")} ×${n}`);
  }, [plansHydrated, archiveHydrated, t]);

  // 视图切换动画
  useGSAP(
    () => {
      gsap.fromTo(
        bodyRef.current,
        { autoAlpha: 0, y: 10 },
        { autoAlpha: 1, y: 0, duration: 0.32, ease: "power2.out", clearProps: "all" },
      );
    },
    { dependencies: [viewTick, date], scope: bodyRef },
  );

  const locale = i18n.language === "en" ? "en-US" : "zh-CN";
  const dateLabel = new Intl.DateTimeFormat(locale, {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(parseDate(date));

  const progress = dayProgress(tasks);
  const isToday = date === todayStr();

  const switchView = (v: ViewKey) => {
    setView(v);
    setViewTick((n) => n + 1);
  };

  const onArchiveDay = async () => {
    if (tasks.length === 0) return;
    const ok = await confirm({
      title: t("plans.archiveConfirm", { date: dateLabel }),
      danger: true,
    });
    if (ok && archiveDay(date)) {
      toast.success(t("plans.archived"));
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-6 pb-10">
        {/* ── 工具栏：日期导航 + 进度 + 归档 ── */}
        <div className="flex flex-wrap items-center gap-2">
          {/* 日期步进器：图标与日期同处一个圆角容器，避免散落的小方块 */}
          <div className="flex items-center gap-0.5 rounded-xl border border-border bg-card p-0.5">
            <button
              type="button"
              onClick={() => setDate(addDays(date, -1))}
              title={t("plans.prevDay")}
              className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
            </button>

            <button
              type="button"
              onClick={() => setDate(todayStr())}
              title={t("plans.backToToday")}
              className="flex items-center gap-2 rounded-lg px-2.5 py-1 text-[13px] font-semibold transition-colors hover:bg-muted"
            >
              <CalendarDays className={cn("size-3.5", isToday ? "text-brand" : "text-muted-foreground")} />
              <span className={isToday ? "text-brand" : "text-foreground"}>{dateLabel}</span>
              {isToday && (
                <span className="rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-bold text-brand">
                  {t("plans.today")}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setDate(addDays(date, 1))}
              title={t("plans.nextDay")}
              className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>

          {/* 进度：数字 + 细进度条，比纯文字徽章更有信息量 */}
          {progress.total > 0 && (
            <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-2.5 py-1.5">
              <span
                className={cn(
                  "text-[11px] font-semibold tabular-nums",
                  progress.done === progress.total ? "text-success" : "text-muted-foreground",
                )}
              >
                {progress.done === progress.total
                  ? t("plans.planDone")
                  : t("plans.progress", progress)}
              </span>
              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                <span
                  className={cn(
                    "block h-full rounded-full transition-[width] duration-300",
                    progress.done === progress.total ? "bg-success" : "bg-brand",
                  )}
                  style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                />
              </span>
            </div>
          )}

          <div className="flex-1" />

          {!isArchivedDay && (
            <button
              type="button"
              onClick={() => void onArchiveDay()}
              title={t("plans.archiveDay")}
              className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-2.5 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-brand/40 hover:text-brand"
            >
              <Archive className="size-3.5" />
              {t("plans.archiveDay")}
            </button>
          )}
        </div>

        {/* ── 视图切换：滑动 pill（与条目属性选择器同一动效语言） ── */}
        <div className="flex w-fit items-center gap-0.5 rounded-xl border border-border bg-muted/40 p-1">
          {VIEW_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => switchView(key)}
              className="relative rounded-lg px-3.5 py-1.5 text-[12px] font-medium"
            >
              {view === key && (
                <motion.span
                  layoutId="plans-view-pill"
                  className="absolute inset-0 rounded-lg bg-card shadow-[var(--pr-shadow-1)] ring-1 ring-border"
                  transition={{ type: "spring", stiffness: 550, damping: 42 }}
                />
              )}
              <span
                className={cn(
                  "relative z-10",
                  view === key ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(`plans.views.${key}`)}
              </span>
            </button>
          ))}
        </div>

        {/* ── 视图主体 ── */}
        <div ref={bodyRef} className="min-h-0">
          {view === "outline" && <OutlineView date={date} />}
          {view === "timeline" && <TimelineView date={date} />}
          {view === "kanban" && <KanbanView date={date} />}
          {view === "calendar" && (
            <CalendarView
              date={date}
              onPick={(d) => {
                setDate(d);
                // 归档日点选 → 跳归档视图
                if (usePlansArchive.getState().days[d]) switchView("archive");
                else switchView("outline");
              }}
            />
          )}
          {view === "archive" && (
            <ArchiveView
              onRestore={(d) => {
                setDate(d);
                switchView("outline");
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
