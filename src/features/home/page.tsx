import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { RiBookOpenLine, RiCalendarCheckLine, RiFolderLine, RiComputerLine, RiPauseLine, RiPlayLine, RiArrowLeftLine } from "@remixicon/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { childrenOf, dayProgress, todayStr } from "@/features/plans/types";
import { useDayTasks, useNow, usePlans } from "@/features/plans/store";
import { listCaptures, openCaptureWindow } from "@/features/knowledge/api";
import { useKnowledge } from "@/features/knowledge/store";
import { useFiles, useFences } from "@/stores/files";
import { deriveHomeRelations } from "./relations";
import { WorkspaceOrbit, type HomeModule, type WorkspaceNode } from "./workspace-orbit";
import { HomeInspector, type InboxSummary } from "./inspector";
import { HomeOverview } from "./overview";

export function HomePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const today = todayStr();
  const tasks = useDayTasks(today);
  const toggleDone = usePlans((state) => state.toggleDone);
  const now = useNow();
  const items = useFiles((state) => state.items);
  const categories = useFiles((state) => state.categories);
  const fences = useFences((state) => state.fences);
  const root = useKnowledge((state) => state.vaultRoot);
  const vaultName = useKnowledge((state) => state.vaultName);
  const [selected, setSelected] = useState<HomeModule | null>(null);
  const [paused, setPaused] = useState(true);
  /**
   * 主页有两种视图：默认「总览」一屏摊开今日计划/待办/笔记/资讯，
   * 「脉络」是原来的星图。想要逐条动手的清单，去「计划管理」——那里才是它的主场，
   * 首页再放一份只会是一条孤零零的行加一大片空白。
   */
  const [view, setView] = useState<"overview" | "orbit">("overview");
  const [captureBusy, setCaptureBusy] = useState(false);
  const workspace = useRef<HTMLDivElement>(null);
  const { inbox, refreshInbox } = useInbox(root);
  const returnCenter = useCallback(() => {
    const activeNode = workspace.current?.querySelector<HTMLButtonElement>('.orbit-node[data-active="true"]');
    setSelected(null);
    requestAnimationFrame(() => activeNode?.focus({ preventScroll: true }));
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      returnCenter();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [returnCenter]);

  const progress = dayProgress(tasks);
  const roots = childrenOf(tasks, null);
  const latest = useMemo(() => [...items].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6), [items]);
  const openCategories = categories.filter((category) => fences[category.id]?.open);
  const relations = useMemo(() => deriveHomeRelations({ tasks, items, categories, fences }), [tasks, items, categories, fences]);
  const dateLabel = new Intl.DateTimeFormat(i18n.language === "en" ? "en-US" : "zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(now);
  const contentCount = selected ? { plans: Math.min(roots.length, 6), files: latest.length, knowledge: Math.min(inbox.records.length, 5), fences: Math.min(openCategories.length, 6) }[selected] : 0;
  const nodes: WorkspaceNode[] = [
    { id: "plans", icon: <RiCalendarCheckLine className="size-5" />, label: t("home.todayPlans"), value: progress.total, detail: t("home.progressLabel", { done: progress.done, total: progress.total }) },
    { id: "files", icon: <RiFolderLine className="size-5" />, label: t("home.collections"), value: items.length, detail: t("home.categoryCount", { count: categories.length }) },
    { id: "knowledge", icon: <RiBookOpenLine className="size-5" />, label: t("nav.knowledge"), value: inbox.status === "ready" ? inbox.records.length : "—", detail: inbox.status === "unbound" ? t("home.vaultUnbound") : inbox.status === "error" ? t("home.inboxUnavailable") : inbox.status === "loading" ? t("home.loadingInbox") : t("home.awaitingOrganize") },
    { id: "fences", icon: <RiComputerLine className="size-5" />, label: t("home.desktopFences"), value: openCategories.length, detail: t("home.fencesOn") },
  ];

  async function capture() {
    if (!root) { navigate("/knowledge"); return; }
    setCaptureBusy(true);
    try { await openCaptureWindow(); }
    catch (error) { toast.error(String(error)); }
    finally { setCaptureBusy(false); }
  }

  function selectModule(id: HomeModule) {
    setSelected(id);
    requestAnimationFrame(() => {
      const panel = workspace.current?.querySelector<HTMLElement>(".home-module-panel");
      // In stacked layouts, reveal the result of selecting a node below the map.
      if (panel && getComputedStyle(panel).position === "relative") {
        panel.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
      }
    });
  }

  return (
    <div className="home-workspace workbench-ui" ref={workspace} data-expanded={selected !== null}>
      <div className="home-content">
        <header className="home-header flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs text-muted-foreground">{dateLabel}</p>
            <h1 className="mt-2 text-[22px] font-semibold tracking-tight">{t("home.workspaceTitle")}</h1>
            {view === "overview" && (
              <p className="mt-1.5 text-[13px] text-muted-foreground">
                {t("home.progressLabel", { done: progress.done, total: progress.total })}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="home-viewswitch" role="group" aria-label={t("home.workspaceTitle")}>
              <button type="button" aria-pressed={view === "overview"} onClick={() => setView("overview")}>
                {t("home.viewOverview")}
              </button>
              <button type="button" aria-pressed={view === "orbit"} onClick={() => setView("orbit")}>
                {t("home.viewOrbit")}
              </button>
            </div>
            {view === "orbit" && (
              <Button variant="ghost" size="icon" aria-label={t(paused ? 'home.resumeScene' : 'home.pauseScene')} title={t(paused ? 'home.resumeScene' : 'home.pauseScene')} aria-pressed={paused} onClick={()=>setPaused(value=>!value)}>{paused?<RiPlayLine className="size-4"/>:<RiPauseLine className="size-4"/>}</Button>
            )}
          </div>
        </header>
        <div className="home-layout">
          {view === "overview" ? (
            <HomeOverview
              tasks={tasks}
              progress={progress}
              inbox={inbox}
              root={root}
              today={today}
              now={now.getTime()}
              onToggle={(id) => toggleDone(today, id)}
              onCapture={() => void capture()}
              captureBusy={captureBusy}
              onRetryInbox={refreshInbox}
            />
          ) : (
            <>
              <WorkspaceOrbit nodes={nodes} selected={selected} onSelect={selectModule} onCenter={returnCenter} relations={relations} paused={paused} contentCount={contentCount} />
              {selected && <div className="home-module-panel" data-module={selected}><button type="button" className="home-return" onClick={returnCenter}><RiArrowLeftLine className="size-4" />{t("home.returnCenter")}<kbd>Esc</kbd></button><HomeInspector selected={selected} tasks={roots} latest={latest} categories={categories} openCategories={openCategories} items={items} inbox={inbox} vaultName={vaultName} today={today} now={now} onToggle={(id) => toggleDone(today, id)} onRetry={refreshInbox} onCapture={()=>void capture()} captureBusy={captureBusy} /></div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Metadata only; refresh on focus and ignore results after unmount or vault changes. */
function useInbox(root: string | null) {
  const [result, setResult] = useState<InboxSummary & { root: string | null }>({ root: null, status: "unbound", records: [] });
  const [revision, setRevision] = useState(0);
  const request = useRef(0);
  const refreshInbox = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const current = ++request.current;
    if (!root) return;
    setResult({ root, status: "loading", records: [] });
    void listCaptures(root).then((records) => {
      if (current === request.current) setResult({ root, status: "ready", records: records.filter((record) => record.status === "inbox") });
    }).catch((error) => {
      if (current === request.current) setResult({ root, status: "error", records: [], error: String(error) });
    });
    return () => { request.current++; };
  }, [root, revision]);
  useEffect(() => {
    window.addEventListener("focus", refreshInbox);
    return () => window.removeEventListener("focus", refreshInbox);
  }, [refreshInbox]);
  const inbox: InboxSummary = !root ? { status: "unbound", records: [] } : result.root === root ? result : { status: "loading", records: [] };
  return { inbox, refreshInbox };
}
