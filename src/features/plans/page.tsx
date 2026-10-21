import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Archive, Undo2, Redo2, MonitorUp } from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { addDays, dayProgress, parseDate, todayStr } from "@/features/plans/types";
import { useDayTasks, usePlans, usePlansArchive, archiveDay, autoArchivePastDays } from "@/features/plans/store";
import { canRedo, canUndo, redoLabel, undoLabel } from "@/features/plans/history";
import { openTodoPaper, closeTodoPaper, inTauri } from "@/lib/tauri";
import { paperGeometryFor, usePapers } from "@/stores/papers";
import { OutlineView } from "@/features/plans/views/outline";
import { KanbanView } from "@/features/plans/views/kanban";
import { TimelineView } from "@/features/plans/views/timeline";
import { CalendarView } from "@/features/plans/views/calendar";
import { ArchiveView } from "@/features/plans/views/archive";
import { StatsView } from "@/features/plans/views/stats";
import { useModal } from "@/components/shell/modal-host";
import { useSettings } from "@/stores/settings";
import { gsap, useGSAP } from "@/lib/gsap";
import { cn } from "@/lib/utils";
import { usePlanCopy } from "@/features/plans/copy";
import { useLocation, useSearchParams } from "react-router-dom";
import { useSettingsHydrated } from "@/stores/settings";

/**
 * 视图键。顺序即 pill 顺序，也是 `1`–`6` 快捷键的顺序。
 * 用 `as const` 数组而不是 union 字面量，是为了让快捷键能从同一份顺序里取键 ——
 * 两处各写一份列表，加视图时必然漏改一处。
 */
export const VIEW_KEYS = ["outline", "timeline", "kanban", "calendar", "stats", "archive"] as const;
export type ViewKey = (typeof VIEW_KEYS)[number];

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

/** 计划管理：日期导航 + 六视图切换（`1`–`6` 快捷键）+ 自动/手动归档 */
export function PlansPage() {
  const copy = usePlanCopy();
  const { t, i18n } = useTranslation();
  const { confirm } = useModal();
  const [date, setDate] = useState(todayStr());
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const searchDate = searchParams.get("date") || "";
  const searchTaskId = searchParams.get("task") || undefined;
  const searchArchived = searchParams.get("archived") === "1";
  const settingsHydrated = useSettingsHydrated();
  // 视图选择持久化：刷新/切页回来仍停在原视图（存 settings.json）
  const view = useSettings((s) => s.plansView);
  const setView = useSettings((s) => s.setPlansView);
  const [viewTick, setViewTick] = useState(0); // 视图切换动画 key

  const plansHydrated = useStoreHydrated(usePlans);
  const archiveHydrated = useStoreHydrated(usePlansArchive);
  const tasks = useDayTasks(date);
  const isArchivedDay = usePlansArchive((s) => date in s.days);
  const searchDateArchived = usePlansArchive((s) => searchDate in s.days);

  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!settingsHydrated || !plansHydrated || !archiveHydrated || !/^\d{4}-\d{2}-\d{2}$/.test(searchDate)) return;
    const parsed = parseDate(searchDate);
    if (parsed.getFullYear() !== Number(searchDate.slice(0, 4)) || parsed.getMonth() + 1 !== Number(searchDate.slice(5, 7)) || parsed.getDate() !== Number(searchDate.slice(8, 10))) return;
    setDate(searchDate);
    setView(searchArchived || searchDateArchived ? "archive" : "outline");
  }, [location.key, location.search, searchDate, searchTaskId, searchArchived, searchDateArchived, settingsHydrated, plansHydrated, archiveHydrated, setView]);

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

  /**
   * `1`–`6` 切视图。
   *
   * 三处必须让行，否则会吞掉用户正在输入的字符：
   * - 焦点在 input / textarea / contentEditable（编辑任务、备注、新建框）
   * - 按了修饰键（Ctrl+1 是别的语义，不该被我们劫持）
   * - 视图键来自同一份 `VIEW_KEYS`，加视图时快捷键自动跟上
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.isContentEditable) return;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > VIEW_KEYS.length) return;
      e.preventDefault();
      switchView(VIEW_KEYS[n - 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // switchView 依赖 setView/setViewTick，二者都稳定；不必进依赖数组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * Ctrl+Z / Ctrl+Y（含 Ctrl+Shift+Z）。
   *
   * 与视图快捷键相反，这个**必须**在输入框里也让行吗？——不让行：
   * 在任务标题输入框里按 Ctrl+Z，用户期望的是「撤销我刚打的字」，
   * 那是浏览器原生行为；我们不该抢。所以这里同样跳过可编辑元素。
   *
   * 但有一个例外：编辑态里点「确认」之后焦点已离开输入框，
   * 此时 Ctrl+Z 应该撤销那次提交 —— 这正好由「焦点不在输入框」自然满足。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      // Ctrl+Y 与 Ctrl+Shift+Z 都是重做（Windows / macOS 两套习惯）
      const isRedo = key === "y" || (key === "z" && e.shiftKey);
      const el = e.target as HTMLElement | null;
      if (el?.isContentEditable) return;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      e.preventDefault();
      const st = usePlans.getState();
      if (isRedo) {
        if (!canRedo(st.history)) {
          toast.message(t("plans.nothingToRedo"));
          return;
        }
        const label = redoLabel(st.history);
        if (st.redo() && label) toast.success(t("plans.redone", { label: t(label) }));
      } else {
        if (!canUndo(st.history)) {
          toast.message(t("plans.nothingToUndo"));
          return;
        }
        const label = undoLabel(st.history);
        if (st.undo() && label) toast.success(t("plans.undone", { label: t(label) }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [t]);

  /* 订阅历史栈：按钮可用状态与提示文案都从这里来 */
  const history = usePlans((s) => s.history);
  const undo = usePlans((s) => s.undo);
  const redo = usePlans((s) => s.redo);

  const onUndo = useCallback(() => {
    const label = undoLabel(history);
    if (undo() && label) toast.success(t("plans.undone", { label: t(label) }));
  }, [history, t, undo]);

  const onRedo = useCallback(() => {
    const label = redoLabel(history);
    if (redo() && label) toast.success(t("plans.redone", { label: t(label) }));
  }, [history, redo, t]);

  /* ── 待办纸片：把这一天放到桌面上 ─────────────────── */

  /** 「开着」是一个持久化的意图（papers[date].open），不是「窗口此刻存在」——
      后者在应用启动前为假，会让纸片无法在重启后自动回来 */
  const paperOn = usePapers((s) => s.papers[date]?.open) ?? false;
  const setPaperOpen = usePapers((s) => s.setOpen);

  const onTogglePaper = async () => {
    if (!inTauri) {
      toast.error(t("files.err.unsupported"));
      return;
    }
    if (paperOn) {
      setPaperOpen(date, false);
      await closeTodoPaper(date).catch(() => undefined);
      return;
    }
    // 标题用本地化日期：Windows 任务栏/Alt+Tab 里看到的是这个串
    setPaperOpen(date, true);
    await openTodoPaper(date, dateLabel, paperGeometryFor(date)).catch(() => undefined);
    toast.success(t("plans.paperOpened"));
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
      <div className="flex w-full flex-col gap-5 p-6 pb-10">
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

          {/* 撤销 / 重做：无历史时禁用而不是隐藏 —— 按钮位置固定，肌肉记忆才管用 */}
          <div className="flex items-center gap-0.5 rounded-xl border border-border bg-card p-0.5">
            <button
              type="button"
              onClick={onUndo}
              disabled={!canUndo(history)}
              title={
                canUndo(history)
                  ? `${t("plans.undoAction")}：${t(undoLabel(history) ?? "")}`
                  : t("plans.nothingToUndo")
              }
              aria-label={t("plans.undoAction")}
              className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
            >
              <Undo2 className="size-4" />
            </button>
            <button
              type="button"
              onClick={onRedo}
              disabled={!canRedo(history)}
              title={
                canRedo(history)
                  ? `${t("plans.redoAction")}：${t(redoLabel(history) ?? "")}`
                  : t("plans.nothingToRedo")
              }
              aria-label={t("plans.redoAction")}
              className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
            >
              <Redo2 className="size-4" />
            </button>
          </div>

          {!isArchivedDay && (
            <button
              type="button"
              onClick={() => void onTogglePaper()}
              title={paperOn ? copy.closeDesktopDay : copy.desktopDay}
              aria-label={paperOn ? copy.closeDesktopDay : copy.desktopDay}
              className={cn(
                "flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[12px] transition-colors",
                paperOn
                  ? "border-brand/40 bg-brand/10 text-brand"
                  : "border-border bg-card text-muted-foreground hover:border-brand/40 hover:text-brand",
              )}
            >
              <MonitorUp className="size-3.5" />
              {paperOn ? t("plans.paperClose") : t("plans.paperOpen")}
            </button>
          )}

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
          {view === "outline" && <OutlineView date={date} searchTaskId={date === searchDate ? searchTaskId : undefined} searchToken={`${location.key}:${location.search}`} />}
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
          {view === "stats" && <StatsView date={date} />}
          {view === "archive" && (
            <ArchiveView
              searchDate={searchDate}
              searchTaskId={searchTaskId}
              searchToken={`${location.key}:${location.search}`}
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
