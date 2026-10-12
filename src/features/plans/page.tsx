import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Archive } from "lucide-react";
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
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6 pb-10">
        {/* ── 头部：日期导航 + 进度 + 归档 ── */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setDate(addDays(date, -1))}
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </button>

          <button
            type="button"
            onClick={() => setDate(todayStr())}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1 text-[14px] font-semibold transition-colors",
              isToday ? "text-brand" : "hover:bg-muted",
            )}
          >
            {dateLabel}
            {isToday && (
              <span className="rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-bold">
                {t("plans.today")}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setDate(addDays(date, 1))}
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className="size-4" />
          </button>

          <div className="flex-1" />

          {progress.total > 0 && (
            <span
              className={cn(
                "rounded-full px-2.5 py-1 text-[11px] font-semibold",
                progress.done === progress.total
                  ? "bg-success/15 text-success"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {progress.done === progress.total
                ? t("plans.planDone")
                : t("plans.progress", progress)}
            </span>
          )}

          {!isArchivedDay && (
            <button
              type="button"
              onClick={() => void onArchiveDay()}
              title={t("plans.archiveDay")}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Archive className="size-3.5" />
              {t("plans.archiveDay")}
            </button>
          )}
        </div>

        {/* ── 视图切换 pills ── */}
        <div className="flex items-center gap-1 rounded-xl border border-border bg-muted/40 p-1">
          {VIEW_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => switchView(key)}
              className={cn(
                "flex-1 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors duration-150",
                view === key
                  ? "bg-background text-foreground shadow-[var(--pr-shadow-1)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`plans.views.${key}`)}
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
