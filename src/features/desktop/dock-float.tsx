import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import {
  AppWindow, ArrowLeft, BookOpen, Bookmark, CalendarCheck, Camera, ChevronDown, ExternalLink, FileText, Folder,
  Bell, CalendarDays, CloudSun, FolderKanban, Inbox, LayoutGrid, Newspaper, SquareTerminal, RefreshCw, Rss, Search, Send, Settings2, Sparkles, Star, Trash2,
} from "lucide-react";
import { ItemIcon } from "@/features/files/icons";
import { useFavorites } from "@/stores/favorites";
import { usePlans } from "@/features/plans/store";
import { todayStr, type PlanTask } from "@/features/plans/types";
import { openSearchResult, searchQuery } from "@/features/search/api";
import type { SearchHit } from "@/features/search/types";
import { mergedSources } from "@/sources/custom";
import type { SourceEntry } from "@/sources/types";
import { useFeeds } from "@/stores/feeds";
import { ArticleReader } from "@/features/feeds/article-reader";
import {
  openUrl,
  openPath,
  openNotificationSettings,
  systemNotifications,
  type SystemNotificationSnapshot,
} from "@/lib/tauri";
import { sortedTopCategories, useFiles } from "@/stores/files";
import { useSettings } from "@/stores/settings";
import { DayPicker, type DayProps } from "react-day-picker";
import { chatWithProvider, type ChatMessage } from "@/features/ai/client";
import { ageBucket, dateKey, summarizeDay } from "./dock-float-core";
import { settleFloatEdge, DOCK_CAPSULE_W, DOCK_CARD_W } from "./dock-core";
import { monitorArea } from "./monitors";
import "./dock-float.css";

/**
 * 六个页：搜索、收纳盒、计划、项目、收集、资讯。
 *
 * 收纳盒 / 计划 / 项目 是侧栏形态里那三个飞出面板**本体**，由 dock.tsx 注入 ——
 * 卡片不重写它们，否则同一功能会出现两套实现、两套密度、两套交互。
 */
type DockTab = "home" | "search" | "fences" | "plans" | "projects" | "collect" | "news" | "cal" | "chat" | "weather" | "notice" | "term";

/**
 * 表面形态。窗口只切换一次尺寸，视觉由 CSS clip-path 负责：
 * compact → resizing（原生窗口先到位）→ expanding（clip 展开）→ expanded；
 * 收起先 collapsing（clip 收窄）→ 原生窗口回胶囊 → compact。
 */
type SurfacePhase = "compact" | "resizing" | "expanding" | "expanded" | "collapsing";

/** 二级功能：日历 / 天气 / 通知 / 终端 —— 只出现在卡片头部的图标区 */
const TOOL_TABS: { key: DockTab; icon: typeof Search }[] = [
  { key: "cal", icon: CalendarDays },
  { key: "weather", icon: CloudSun },
  { key: "notice", icon: Bell },
  { key: "term", icon: SquareTerminal },
];

/**
 * 展开卡底部的**动作行**（P0 定稿）：图标 + 文字，点哪儿去哪儿。
 * 取代了旧版「胶囊里摆 11 颗图标」—— 入口只住在展开的卡片里。
 */
const ACT_ROW: { key: DockTab; icon: typeof Search }[] = [
  { key: "home", icon: Sparkles },
  { key: "search", icon: Search },
  { key: "fences", icon: LayoutGrid },
  { key: "plans", icon: CalendarCheck },
  { key: "projects", icon: FolderKanban },
  { key: "collect", icon: Inbox },
  { key: "news", icon: Newspaper },
];

/** 主页（P0 定稿 v4）：今日待办 / 日历 / 天气 / 收纳盒 —— 收纳盒直接摆条目本体，能点能启动。 */
function HomePanel({ onOpen }: { onOpen: (tab: DockTab) => void }) {
  const { t } = useTranslation();
  const today = todayStr();
  const tasks = usePlans((state) => state.days[today]) ?? [];
  const summary = summarizeDay(tasks);
  const categories = useFiles((state) => state.categories);
  const items = useFiles((state) => state.items);
  const next = tasks.find((task) => !task.done);
  const cats = sortedTopCategories(categories);
  const apps = cats.flatMap((category) => items.filter((item) => item.categoryId === category.id)).slice(0, 8);
  const launch = (item: (typeof apps)[number]) =>
    (item.type === "url" ? openUrl(item.path) : openPath(item.path)).catch(report);
  return (
    <div className="df-home">
      <div className="df-hcard" role="button" tabIndex={0} onClick={() => onOpen("plans")}>
        <span className="tt"><CalendarCheck />{t("dockFloat.homeTodo")}</span>
        <span className="mid">
          <span className="big">{summary.todo}</span>
          <span className="unit">{t("dockFloat.todoUnit")}</span>
        </span>
        <span className="pv">{next ? <b>{next.title}</b> : t("dockFloat.homeNothing")}</span>
      </div>
      <div className="df-hcard" role="button" tabIndex={0} onClick={() => onOpen("cal")}>
        <span className="tt"><CalendarDays />{t("dockFloat.tab.cal")}</span>
        <span className="mid">
          <span className="big">{today.slice(8)}</span>
          <span className="unit">{today.slice(0, 7)}</span>
        </span>
        <span className="pv">{t("dockFloat.homeTodayFree")}</span>
      </div>
      <div className="df-hcard" role="button" tabIndex={0} onClick={() => onOpen("weather")}>
        <WeatherCardBody />
      </div>
      <div className="df-hcard" role="button" tabIndex={0} onClick={() => onOpen("fences")}>
        <span className="tt"><Folder />{t("dockFloat.tab.fences")} · {items.length}</span>
        <span className="apps">
          {apps.length === 0
            ? <span className="df-hint">{t("dockFloat.homeFencesEmpty")}</span>
            : apps.map((item) => (
              <span key={item.id} className="df-app" title={item.title}
                onClick={(event) => { event.stopPropagation(); void launch(item); }}>
                <ItemIcon type={item.type} path={item.path} iconUrl={item.iconUrl} size={22} />
              </span>
            ))}
        </span>
        <span className="pv">{t("dockFloat.homeFencesHint")}</span>
      </div>
    </div>
  );
}

const report = (error: unknown) => console.error("[dock-float]", error);

/**
 * 胶囊形态的 Dock：一颗 44px 药丸，点开原地长成 660×591 的卡片。
 *
 * 与侧栏版本共用同一个窗口，只换锚点与尺寸（见 dock-core 的 dockFloatBounds）。
 * 五个页都在卡片内完成，只有齿轮跳主窗口 —— 这是「3 秒内能完成」这条规则的边界：
 * 超过 3 秒的事（树形编辑、批量整理、订阅管理）一律跳主窗口。
 */
export interface DockFloatPanels {
  fences: React.ReactNode;
  plans: React.ReactNode;
  projects: React.ReactNode;
  capture: React.ReactNode;
}

export function DockFloat({ onExpand, onHide, panels }: {
  onExpand: (open: boolean, height?: number) => Promise<void>;
  onHide: () => void;
  panels: DockFloatPanels;
}) {
  const { t } = useTranslation();
  const today = todayStr();
  const tasks = usePlans((state) => state.days[today]) ?? [];
  const [phase, setPhase] = useState<SurfacePhase>("compact");
  const [tab, setTab] = useState<DockTab>("home");
  /** 对话是「副页」而不是第七个 tab：标签已经六个，再多就挤成图标了 */
  const [chatOpen, setChatOpen] = useState(false);
  const summary = useMemo(() => summarizeDay(tasks), [tasks]);
  const [clock, setClock] = useState(() => new Date().toTimeString().slice(0, 5));
  /** 收起形态：胶囊（信息全）/ 指示条（只剩一条线，最大化窗口时最不碍事） */
  const compactStyleSetting = useSettings((state) => state.dockCompactStyle);
  /** 悬浮胶囊吸附的边：贴左右缘时胶囊转竖排（CSS 按 data-float-edge 适配） */
  const floatEdge = useSettings((state) => state.dockFloatEdge);
  /**
   * 前台窗口最大化时自动切成指示条（对应 BrimDeck 的「最大化切指示条」）。
   * 手动设置仍然优先：用户选了指示条就一直是指示条；选了胶囊则只在最大化
   * 期间临时变成指示条，退出最大化自动变回来。
   */
  const [foregroundMax, setForegroundMax] = useState(false);
  useEffect(() => {
    let stop: (() => void) | undefined;
    void listen<number>("dock-foreground", (event) => setForegroundMax(event.payload === 1))
      .then((unlisten) => { stop = unlisten; }).catch(() => undefined);
    return () => stop?.();
  }, []);
  const compactStyle = foregroundMax ? "line" : compactStyleSetting;

  useEffect(() => {
    const timer = setInterval(() => setClock(new Date().toTimeString().slice(0, 5)), 30_000);
    return () => clearInterval(timer);
  }, []);

  /**
   * 卡片挂载一次之后常驻：收起时靠 clip 收窄，不卸载收纳盒/计划/项目
   * 三个真面板 —— 再挂载一次要读数据、建列表，才是「展开卡一下」的来源。
   */
  const [mounted, setMounted] = useState(false);
  const phaseRef = useRef<SurfacePhase>("compact");
  const transitionGeneration = useRef(0);
  /** 同步更新 ref：快速连续点击时 setExpanded 不能读到上一次 useEffect 的旧相位。 */
  const setSurfacePhase = useCallback((next: SurfacePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);
  const phaseTimer = useRef<number | null>(null);
  /** 原生窗口过渡串行化：快速 hover 时 set_size 不能互相超车。 */
  const windowTransition = useRef<Promise<void>>(Promise.resolve());
  /** 当前页签的 ref：相位机里要读「这页该多高」，不想把 tab 加进依赖反复重挂 */
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const open = phase === "expanding" || phase === "expanded";

  useEffect(() => {
    phaseRef.current = phase;
    if (phase !== "compact") setMounted(true);
  }, [phase]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--df-card-h",
      String(useSettings.getState().dockCardHeight) + "px",
    );
    /*
     * 收拢动画的 clip 终点必须正好是胶囊的可见矩形：
     * 横向内缩 = (卡片宽 − 胶囊宽) / 2。这个值写死过 98px（464 宽胶囊时代），
     * 胶囊改 244 后没跟着算 —— 收拢的最后一帧就会从「长条」跳成「短条」。
     */
    document.documentElement.style.setProperty("--df-capsule-w", String(DOCK_CAPSULE_W) + "px");
    document.documentElement.style.setProperty(
      "--df-capsule-inset-x",
      String(Math.round((DOCK_CARD_W - DOCK_CAPSULE_W) / 2)) + "px",
    );
    return () => {
      if (phaseTimer.current !== null) window.clearTimeout(phaseTimer.current);
    };
  }, []);

  // 形变起点的裁剪区域按吸附边走：top = 顶部居中胶囊；left/right = 缘上的竖排胶囊
  useEffect(() => {
    const clip = floatEdge === "left"
      ? "inset(0 calc(100% - 44px) calc(100% - 150px) 0 round 22px)"
      : floatEdge === "right"
        ? "inset(0 0 calc(100% - 150px) calc(100% - 44px) round 22px)"
        : "inset(0 var(--df-capsule-inset-x, 208px) calc(var(--df-card-h, 591px) - 44px) var(--df-capsule-inset-x, 208px) round 22px)";
    document.documentElement.style.setProperty("--df-clip-compact", clip);
  }, [floatEdge]);

  const runWindowTransition = useCallback((nextOpen: boolean, height?: number) => {
    const next = windowTransition.current.then(() => onExpand(nextOpen, height));
    windowTransition.current = next.catch(() => undefined);
    return next;
  }, [onExpand]);

  /**
   * 展开/收起只做两件事：切换视觉相位 + 串行提交一次原生尺寸。
   * 窗口尺寸永远先于 expand 动画、后于 collapse 动画，避免「内容先没、窗口后缩」
   * 或「窗口突然变大、内容还在旧尺寸」的两次跳变。
   */
  const setExpanded = useCallback((next: boolean) => {
    const current = phaseRef.current;
    if (next) {
      if (current === "resizing" || current === "expanding" || current === "expanded") return;
      const generation = ++transitionGeneration.current;
      if (phaseTimer.current !== null) { window.clearTimeout(phaseTimer.current); phaseTimer.current = null; }
      suppressHoverUntil.current = Date.now() + 700;
      setMounted(true);
      setSurfacePhase("resizing");
      // 活动页内容矮（四张卡一行）：展开高度按页走
      void runWindowTransition(true, tabRef.current === "home" ? 252 : undefined).then(() => {
        if (generation !== transitionGeneration.current) return;
        // 等 WebView2 收到 WM_SIZE 再开始 clip，避免窗口还没到位、内容先展开。
        window.setTimeout(() => {
          if (generation !== transitionGeneration.current) return;
          setSurfacePhase("expanding");
          phaseTimer.current = window.setTimeout(() => {
            if (generation !== transitionGeneration.current) return;
            phaseTimer.current = null;
            setSurfacePhase("expanded");
          }, 240);
        }, 16);
      }).catch(report);
      return;
    }

    if (current === "compact" || current === "collapsing") return;
    const generation = ++transitionGeneration.current;
    if (phaseTimer.current !== null) { window.clearTimeout(phaseTimer.current); phaseTimer.current = null; }
    suppressHoverUntil.current = Date.now() + 700;
    setSurfacePhase("collapsing");
    phaseTimer.current = window.setTimeout(() => {
      if (generation !== transitionGeneration.current) return;
      phaseTimer.current = null;
      void runWindowTransition(false).then(() => {
        if (generation !== transitionGeneration.current) return;
        // 先让缩小后的 WebView2 完成一帧布局，再切 compact；否则卡片会先消失、
        // 窗口后缩，看起来就是「收起时刷新了一下」。
        window.setTimeout(() => {
          if (generation !== transitionGeneration.current) return;
          setSurfacePhase("compact");
        }, 16);
      }).catch(report);
    }, 240);
  }, [runWindowTransition, setSurfacePhase]);

  /**
   * 收起：移开 500ms 后自动收（去点面板的路上不会自己关）；Esc 同效。
   * 展开只由**点击**触发（chevron / 胶囊本体）—— 悬停展开已按用户要求移除。
   */
  const hoverTimer = useRef<number | null>(null);
  const suppressHoverUntil = useRef(0);
  const clearHoverTimer = () => {
    if (hoverTimer.current !== null) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null; }
  };
  const hoverCollapse = () => {
    clearHoverTimer();
    hoverTimer.current = window.setTimeout(() => {
      const focus = document.activeElement as HTMLElement | null;
      if (focus && focus.closest(".df-card")) return;
      setExpanded(false);
    }, 500);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); clearHoverTimer(); };
  }, [setExpanded]);

  // 展开中切页：活动页矮（四张卡一行），窗口高度平滑跟过去；其它页回默认卡高
  useEffect(() => {
    if (phase !== "expanded" && phase !== "expanding") return;
    void onExpand(true, tab === "home" ? 252 : undefined).catch(report);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);


  return (
    <div className="df-root" data-open={open} data-phase={phase} data-compact-style={compactStyle}
      data-float-edge={floatEdge}
      onPointerLeave={hoverCollapse}>
      {compactStyle === "line" ? (
        <div className="df-line" data-open={open}
          onPointerDown={(event) => { if (event.button === 0) setExpanded(true); }}>
          <span className={summary.late > 0 ? "df-line-bar is-warn" : "df-line-bar"} />
        </div>
      ) : (
      <div className="df-capsule" data-open={open}
        onClick={() => { if (!open) setExpanded(true); }}
          data-drag
          onPointerDown={(event) => {
            // 空白处/文字上按住就拖走；图标按钮照常点击。
            // 松手后**吸附到最近的屏幕边**（上 / 左 / 右，用户定的规矩不含下），
            // 并立即按吸附结果落位 —— 胶囊不会悬在屏幕中间。
            if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
            const win = getCurrentWebviewWindow();
            void (async () => {
              await win.startDragging();
              const [pos, size, monitor] = await Promise.all([
                win.outerPosition(),
                win.outerSize(),
                import("@tauri-apps/api/window").then((m) => m.currentMonitor()),
              ]);
              if (!monitor) return;
              const scale = monitor.scaleFactor ?? 1;
              const area = monitorArea(monitor);
              const rect = { x: pos.x / scale, y: pos.y / scale, w: size.width / scale, h: size.height / scale };
              const store = useSettings.getState();
              // 吸附 or 自由：离允许的边 ≤56px 才贴边，否则停在拖到的位置
              const settle = settleFloatEdge(rect, area);
              store.setDockFloatEdge(settle.edge);
              store.setDockFloatX(settle.x);
              store.setDockFloatY(settle.y);
              void onExpand(open).catch(() => undefined);
            })().catch(() => undefined);
          }}>
          <span className="df-orb" aria-hidden="true" />
          <span className="df-name">{t("dockFloat.title")}</span>
          <span className="df-sep" aria-hidden="true" />
          {/* 状态轮播（P0 定稿）：一次只读一条 —— 时间 / 待办，小圆点提示还有下一条。
              胶囊不再摆功能图标：想做什么就悬停或点箭头展开，展开的卡片里才有入口。 */}
          <span className="df-ring" title={t("dockFloat.ringTitle", { done: summary.done, total: summary.todo + summary.done })}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <circle cx="8" cy="8" r="6" className="df-ring-bg" />
              <circle cx="8" cy="8" r="6" className="df-ring-fg"
                strokeDasharray={`${2 * Math.PI * 6 * (summary.todo + summary.done ? summary.done / (summary.todo + summary.done) : 0)} ${2 * Math.PI * 6}`}
                transform="rotate(-90 8 8)" />
            </svg>
          </span>
          <span className="df-stat">
            <b>{summary.todo}</b>
            <span className="df-stat-unit">{t("dockFloat.todoUnit")}{summary.late > 0 && <> · <b className="is-warn">{summary.late}</b> {t("dockFloat.lateUnit")}</>}</span>
          </span>
          <span className="df-clock">{clock}</span>
          <button type="button" className="df-expand"
            title={open ? t("dockFloat.collapse") : t("dockFloat.expand")}
            aria-label={open ? t("dockFloat.collapse") : t("dockFloat.expand")}
            onClick={(event) => { event.stopPropagation(); setExpanded(!open); }}>
            <ChevronDown className={open ? "df-icon is-flip" : "df-icon"} aria-hidden="true" />
          </button>
        </div>
      )}

      {mounted && (
        <div className="df-card">
          <div className="df-card-content">
            {/* 工具与设置只在展开态出现；顶部的 5 个主图标始终留在胶囊栏里不动 */}
            <div className="df-toolbar">
              <span className="df-page-title">
                {chatOpen ? t("dockFloat.chatTitle") : t(`dockFloat.tab.${tab}`)}
              </span>
              <span className="df-sp" />
              <span className="df-tools" role="group" aria-label={t("dockFloat.tools")}>
                {TOOL_TABS.map(({ key, icon: Icon }) => (
                  <button key={key} type="button" className="df-icon-btn" title={t(`dockFloat.tab.${key}`)}
                    aria-label={t(`dockFloat.tab.${key}`)} aria-pressed={tab === key}
                    onClick={() => setTab(key)}>
                    <Icon className="df-icon" aria-hidden="true" />
                  </button>
                ))}
              </span>
              <span className="df-window-actions">
                <button type="button" className="df-icon-btn" title={t("dockFloat.chatTitle")}
                  aria-label={t("dockFloat.chatTitle")} aria-pressed={chatOpen}
                  onClick={() => setChatOpen((value) => !value)}>
                  <Sparkles className="df-icon" aria-hidden="true" />
                </button>
                <button type="button" className="df-icon-btn" title={t("dockFloat.settings")}
                  aria-label={t("dockFloat.settings")}
                  onClick={() => invoke("desktop_open_main", { route: "/settings" }).catch(report)}>
                  <Settings2 className="df-icon" aria-hidden="true" />
                </button>
              </span>
            </div>

            {chatOpen ? (
              <div className="df-body"><ChatPanel onClose={() => setChatOpen(false)} /></div>
            ) : (
              <div className="df-body">
                {tab === "home" && <HomePanel onOpen={setTab} />}
                {tab === "search" && <SearchPanel />}
                {tab === "fences" && <div className="df-host">{panels.fences}</div>}
                {tab === "plans" && <div className="df-host">{panels.plans}</div>}
                {tab === "projects" && <div className="df-host">{panels.projects}</div>}
                {tab === "collect" && (
                  <div className="df-collect">{panels.capture}</div>
                )}
                {tab === "news" && <NewsPanel />}
                {tab === "cal" && <CalendarPanel />}
                {tab === "chat" && <div className="df-body-inner"><ChatPanel onClose={() => setTab("search")} /></div>}
                {tab === "weather" && <WeatherPanel />}
                {tab === "notice" && <NoticePanel onOpenPlans={() => setTab("plans")} />}
                {tab === "term" && <TerminalPanel />}
              </div>
            )}

            {/* 动作行（P0 定稿）：图标 + 文字，当前页高亮 —— 岛的入口只住在这里 */}
            <nav className="df-actrow" role="tablist" aria-label={t("dockFloat.title")}>
              {ACT_ROW.map(({ key, icon: Icon }) => (
                <button key={key} type="button" role="tab" aria-selected={tab === key}
                  className={tab === key ? "df-act is-on" : "df-act"}
                  onClick={() => { setTab(key); setChatOpen(false); }}>
                  <Icon className="df-icon" aria-hidden="true" />
                  <span>{t(`dockFloat.tab.${key}`)}</span>
                </button>
              ))}
            </nav>

            <div className="df-foot">
              <span>{t("dockFloat.footSummary", { todo: summary.todo, late: summary.late })}</span>
              <span className="df-sp" />
              <kbd>Ctrl K</kbd>
              <span>{t("dockFloat.footSearch")}</span>
              <button type="button" className="df-link" onClick={onHide}>{t("dockFloat.hide")}</button>
            </div>
            <div className="df-resize" role="separator" aria-orientation="horizontal"
              aria-label={t("dockFloat.resize")}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                const startY = event.clientY;
                const startH = useSettings.getState().dockCardHeight;
                let frame = 0;
                let next = startH;
                const move = (ev: PointerEvent) => {
                  next = Math.round(Math.min(900, Math.max(420, startH + (ev.clientY - startY))) / 10) * 10;
                  document.documentElement.style.setProperty("--df-card-h", next + "px");
                  // 窗口跟着长：rAF 合并，避免每个 pointermove 都打一次 IPC
                  if (!frame) frame = requestAnimationFrame(() => { frame = 0; void onExpand(true, next).catch(report); });
                };
                const up = () => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                  useSettings.getState().setDockCardHeight(next);
                  void onExpand(true, next).catch(report);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              }} />
          </div>
        </div>
      )}
    </div>
  );
}

/** 搜索：范围 chips + 类型图标 + 结果行，语义与原搜索窗一致（点一条直接打开）。 */
const SEARCH_SCOPES = ["all", "file", "plan", "project", "knowledge", "feed"] as const;
const HIT_ICONS = { app: AppWindow, file: FileText, folder: Folder, plan: CalendarCheck, knowledge: BookOpen, feed: Rss, bookmark: Bookmark, project: FolderKanban } as const;

function SearchPanel() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<(typeof SEARCH_SCOPES)[number]>("all");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const needle = query.trim();
    if (!needle) { setHits([]); setBusy(false); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      setBusy(true);
      searchQuery(needle, "all", true)
        .then((reply) => { if (!cancelled) setHits(reply.results.slice(0, 40)); })
        .catch(() => { if (!cancelled) setHits([]); })
        .finally(() => { if (!cancelled) setBusy(false); });
    }, 220);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  const visible = useMemo(
    () => hits.filter((hit) => scope === "all" || hit.kind === scope).slice(0, 10),
    [hits, scope],
  );

  return (
    <div className="df-panel df-search">
      {/* 左栏：范围做竖排导航，比横着一排小胶囊好扫，也给结果区腾出整块宽 */}
      <nav className="df-search-rail" role="tablist" aria-label={t("dockFloat.tab.search")}>
        {SEARCH_SCOPES.map((key) => (
          <button key={key} type="button" role="tab" aria-selected={scope === key}
            className={`df-rail-item${scope === key ? " is-on" : ""}`}
            onClick={() => setScope(key)}>
            {t(`dockFloat.scope.${key}`)}
          </button>
        ))}
      </nav>

      <div className="df-search-main">
        <label className="df-field">
          <Search className="df-icon" aria-hidden="true" />
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder={t("dockFloat.searchPlaceholder")} aria-label={t("dockFloat.tab.search")} />
          {busy && <span className="df-row-meta">{t("dockFloat.searching")}</span>}
        </label>
        {query.trim() && !busy && visible.length === 0 && <p className="df-hint">{t("dockFloat.noResult")}</p>}
        <div className="df-rows">
        {visible.map((hit) => {
          const Icon = HIT_ICONS[hit.kind as keyof typeof HIT_ICONS] ?? FileText;
          return (
            <button key={hit.id} type="button" className="df-row" title={hit.subtitle || hit.path || hit.url || ""}
              onClick={() => openSearchResult(hit).catch(report)}>
              <Icon className="df-icon" aria-hidden="true" />
              <span className="df-row-title">{hit.title}</span>
              <span className="df-row-meta">{hit.subtitle || hit.path || hit.url || ""}</span>
            </button>
          );
        })}
        </div>
      </div>
    </div>
  );
}

/**
 * 资讯：按信息源顺序平铺，每 30 秒自动往下滚一行；**点标题在卡片内展开正文**，
 * 星标收藏（存 favorites），右上角外链才是「去原网页」。
 *
 * 为什么正文在卡片里读：资讯是「扫一眼 → 决定要不要读」的两段行为，跳浏览器
 * 会把第二段打断；只有需要原排版/评论时才出卡片。
 */
function NewsPanel() {
  const { t } = useTranslation();
  const entriesBySource = useFeeds((state) => state.entriesBySource);
  const sources = useMemo(() => mergedSources(), []);
  const favorites = useFavorites((state) => state.items);
  const toggleFavorite = useFavorites((state) => state.toggle);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [reading, setReading] = useState<{ entry: SourceEntry; source: string } | null>(null);

  const items = useMemo(() => {
    const nameOf = new Map(sources.map((source) => [source.id, source.name]));
    return Object.entries(entriesBySource).flatMap(([sourceId, entries]) =>
      entries.map((entry) => ({ entry, source: nameOf.get(sourceId) ?? sourceId })),
    );
  }, [entriesBySource, sources]);

  useEffect(() => {
    const node = viewRef.current;
    if (!node || items.length === 0 || reading) return;
    const timer = setInterval(() => {
      const row = node.querySelector<HTMLElement>(".df-news-row");
      const step = row ? row.offsetHeight + 1 : 32;
      const atEnd = node.scrollTop + node.clientHeight >= node.scrollHeight - 4;
      node.scrollTo({ top: atEnd ? 0 : node.scrollTop + step, behavior: "smooth" });
    }, 30_000);
    return () => clearInterval(timer);
  }, [items.length, reading]);

  if (reading) {
    return (
      <div className="df-panel df-reader">
        <div className="df-reader-bar">
          <button type="button" className="df-icon-btn" aria-label={t("dockFloat.back")}
            onClick={() => setReading(null)}>
            <ArrowLeft className="df-icon" aria-hidden="true" />
          </button>
          <span className="df-reader-src">{reading.source}</span>
          <span className="df-sp" />
          <button type="button" className="df-icon-btn" aria-label={t("dockFloat.openOriginal")}
            title={t("dockFloat.openOriginal")} onClick={() => openUrl(reading.entry.url).catch(report)}>
            <ExternalLink className="df-icon" aria-hidden="true" />
          </button>
        </div>
        <div className="df-reader-body">
          <ArticleReader entry={reading.entry} sourceName={reading.source}
            onOpen={(url) => openUrl(url).catch(report)} />
        </div>
      </div>
    );
  }

  if (items.length === 0) return <p className="df-hint">{t("dockFloat.newsEmpty")}</p>;

  return (
    <div className="df-panel df-news" ref={viewRef}>
      {items.map(({ entry, source }) => {
        const age = ageBucket(entry.pubDate);
        const saved = favorites.some((item) => item.url === entry.url);
        return (
          <div key={`${source}-${entry.id}`} className="df-news-row">
            <button type="button" className="df-news-open" title={entry.title}
              onClick={() => setReading({ entry, source })}>
              <span className="df-row-title">{entry.title}</span>
              <span className="df-row-meta">
                {source}
                {age && <span>{t(`dockFloat.age.${age.unit}`, { count: age.value })}</span>}
              </span>
            </button>
            <button type="button" className={`df-news-act${saved ? " is-on" : ""}`}
              aria-pressed={saved} aria-label={t("dockFloat.favorite")} title={t("dockFloat.favorite")}
              onClick={() => toggleFavorite(entry, source)}>
              <Star className="df-icon" aria-hidden="true" />
            </button>
            <button type="button" className="df-news-act" aria-label={t("dockFloat.openOriginal")}
              title={t("dockFloat.openOriginal")} onClick={() => openUrl(entry.url).catch(report)}>
              <ExternalLink className="df-icon" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 日历页：react-day-picker + 项目 token。
 *
 * **不 import 它自带的 style.css**：默认样式表会覆盖 tokens 的字号、圆角与颜色。
 * 这里只用 classNames / components.Day 接结构，所有视觉值都走 var(--...)；
 * fixedWeeks 保证 6 行恒定，切月份不会把卡片高度顶来顶去。
 */
function CalendarDay({ day, modifiers, className, children, ...props }: DayProps) {
  return (
    <td
      {...props}
      data-date={dateKey(day.date)}
      className={["df-calpicker-cell", className, modifiers.hasTasks ? "has-tasks" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
      {modifiers.hasTasks && <span className="df-calpicker-dot" aria-hidden="true" />}
    </td>
  );
}

function CalendarPanel() {
  const { t } = useTranslation();
  const days = usePlans((state) => state.days);
  const [selectedDate, setSelectedDate] = useState(() => new Date());

  const hasTasks = useCallback(
    (date: Date) => (days[dateKey(date)]?.length ?? 0) > 0,
    [days],
  );

  /** 当天条目按树展开：父任务在前，子任务缩进跟在后面。 */
  const rows = useMemo(() => {
    const tasks = days[dateKey(selectedDate)] ?? [];
    const output: { task: PlanTask; depth: number }[] = [];
    const seen = new Set<string>();
    const walk = (parentId: string | null, depth: number) => {
      for (const task of tasks) {
        if (task.parentId !== parentId) continue;
        seen.add(task.id);
        output.push({ task, depth });
        walk(task.id, depth + 1);
      }
    };
    walk(null, 0);
    // 数据异常时别把孤儿任务吞掉（父 id 指向已删除的条目）
    for (const task of tasks) if (!seen.has(task.id)) output.push({ task, depth: 0 });
    return output;
  }, [days, selectedDate]);

  const weekday = ["su", "mo", "tu", "we", "th", "fr", "sa"][selectedDate.getDay()];
  return (
    <div className="df-calendar">
      <DayPicker
        mode="single"
        selected={selectedDate}
        onSelect={(date) => { if (date) setSelectedDate(date); }}
        showOutsideDays
        fixedWeeks
        weekStartsOn={1}
        modifiers={{ hasTasks }}
        modifiersClassNames={{ hasTasks: "has-tasks" }}
        components={{ Day: CalendarDay }}
        formatters={{
          formatCaption: (month) =>
            t("dockFloat.calendarMonth", { year: month.getFullYear(), month: month.getMonth() + 1 }),
          formatWeekdayName: (date) =>
            t(`dockFloat.week.${["su", "mo", "tu", "we", "th", "fr", "sa"][date.getDay()]}`),
        }}
        labels={{
          labelPrevious: () => t("dockFloat.prevMonth"),
          labelNext: () => t("dockFloat.nextMonth"),
        }}
        classNames={{
          root: "df-calpicker",
          months: "df-calpicker-months",
          month: "df-calpicker-month",
          month_caption: "df-calpicker-caption",
          caption_label: "df-calpicker-caption-label",
          nav: "df-calpicker-nav",
          button_previous: "df-calpicker-nav-btn",
          button_next: "df-calpicker-nav-btn",
          month_grid: "df-calpicker-grid",
          weekdays: "df-calpicker-weekdays",
          weekday: "df-calpicker-weekday",
          week: "df-calpicker-week",
          day_button: "df-calpicker-day",
          selected: "is-selected",
          today: "is-today",
          outside: "is-outside",
          disabled: "is-disabled",
          hidden: "is-hidden",
        }}
      />
      <div className="df-calendar-day">
        <div className="df-calendar-day-head">
          <span>
            {t("dockFloat.calendarDayTitle", { month: selectedDate.getMonth() + 1, day: selectedDate.getDate() })}
            <span className="df-calendar-weekday">{t(`dockFloat.week.${weekday}`)}</span>
          </span>
          <span className="df-row-meta">{t("dockFloat.calendarCount", { count: rows.length })}</span>
        </div>
        {rows.length === 0 ? (
          <p className="df-hint">{t("dockFloat.dayEmpty")}</p>
        ) : (
          <div className="df-calendar-list">
            {rows.map(({ task, depth }) => (
              <div key={task.id} className="df-calendar-row" style={{ paddingLeft: 6 + depth * 14 }}>
                <span className={`df-calendar-mark${task.done ? " is-done" : ""}`} aria-hidden="true" />
                <span className="df-calendar-row-main">
                  <span className={`df-calendar-title${task.done ? " is-done" : ""}`}>{task.title}</span>
                  {(task.start || task.end) && (
                    <span className="df-row-meta">
                      {task.start ?? ""}{task.end ? ` – ${task.end}` : ""}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * AI 对话：卡片内的多轮会话。
 *
 * 上屏的只有 user/assistant 两种消息，历史留在组件里（收起卡片再打开还在，
 * 关掉应用就没了）—— 会话不进持久化是刻意的：它可能包含临时贴进去的私密
 * 内容，落盘要用户明确要求。
 */
function ChatPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  /** 待发送的前台窗口截图（data URL）；只活在这一条消息里，发完就清 */
  const [shot, setShot] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const capture = async () => {
    try { setShot(await invoke<string>("window_capture")); }
    catch (cause) { console.error("[dock-float] capture", cause); }
  };

  const send = async () => {
    const text = draft.trim();
    if ((!text && !shot) || busy) return;
    const content: ChatMessage["content"] = shot
      ? [
          ...(text ? [{ type: "text" as const, text }] : []),
          { type: "image_url" as const, image_url: { url: shot } },
        ]
      : text;
    const next = [...messages, { role: "user" as const, content }];
    setShot(null);
    setMessages(next);
    setDraft("");
    setBusy(true);
    try {
      const answer = await chatWithProvider(next);
      setMessages([...next, { role: "assistant", content: answer }]);
    } catch (cause) {
      setMessages([...next, { role: "assistant", content: String(cause) }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="df-panel df-chat">
      <div className="df-reader-bar">
        <Sparkles className="df-icon" aria-hidden="true" />
        <span className="df-reader-src">{t("dockFloat.chatTitle")}</span>
        <span className="df-sp" />
        <button type="button" className="df-icon-btn" aria-label={t("dockFloat.chatShot")}
          title={t("dockFloat.chatShot")} onClick={() => void capture()}>
          <Camera className="df-icon" aria-hidden="true" />
        </button>
        {messages.length > 0 && (
          <button type="button" className="df-icon-btn" aria-label={t("dockFloat.chatClear")}
            title={t("dockFloat.chatClear")} onClick={() => setMessages([])}>
            <Trash2 className="df-icon" aria-hidden="true" />
          </button>
        )}
        <button type="button" className="df-icon-btn" aria-label={t("dockFloat.back")} onClick={onClose}>
          <ArrowLeft className="df-icon" aria-hidden="true" />
        </button>
      </div>

      <div className="df-chat-list" ref={listRef}>
        {messages.length === 0 && <p className="df-hint">{t("dockFloat.chatEmpty")}</p>}
        {messages.map((message, index) => (
          <div key={index} className={`df-msg${message.role === "user" ? " is-user" : ""}`}>
            {typeof message.content === "string"
              ? message.content
              : message.content.map((part) => (part.type === "text" ? part.text : "🖼")).join("\n")}
          </div>
        ))}
        {busy && <p className="df-hint">{t("dockFloat.chatBusy")}</p>}
      </div>

      {shot && (
        <div className="df-shot">
          <img src={shot} alt={t("dockFloat.chatShotAlt")} />
          <button type="button" className="df-icon-btn" aria-label={t("dockFloat.chatShotClear")}
            onClick={() => setShot(null)}>
            <Trash2 className="df-icon" aria-hidden="true" />
          </button>
        </div>
      )}

      <form className="df-field df-chat-form" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <input value={draft} onChange={(event) => setDraft(event.target.value)}
          placeholder={t("dockFloat.chatPlaceholder")} maxLength={4000}
          aria-label={t("dockFloat.chatPlaceholder")} />
        <button type="submit" className="df-icon-btn" disabled={busy || !draft.trim()}
          aria-label={t("dockFloat.chatSend")}>
          <Send className="df-icon" aria-hidden="true" />
        </button>
      </form>
    </div>
  );
}


/**
 * 天气：Open-Meteo（免 key、免注册）。
 *
 * 坐标暂时写死在上海，设置项等确认数据源后再补 —— 先把「能拿到真数据」
 * 这条路打通，比先做配置界面重要。缓存 10 分钟，避免每次切页都请求。
 */
let weatherCache: { at: number; data: WeatherNow } | null = null;
interface WeatherNow { temp: number; code: number; wind: number; days: { date: string; max: number; min: number; code: number }[] }

let weatherLoading = false;
let weatherWaiters: ((data: WeatherNow | null) => void)[] = [];

/** 拉天气（10 分钟缓存）：天气面板与主页天气卡共用这一份 —— 谁先触发谁拉，其余等同一份结果。 */
function ensureWeather(): Promise<WeatherNow | null> {
  if (weatherCache && Date.now() - weatherCache.at < 10 * 60_000) {
    return Promise.resolve(weatherCache.data);
  }
  if (weatherLoading) {
    return new Promise((resolve) => weatherWaiters.push(resolve));
  }
  weatherLoading = true;
  void (async () => {
    let data: WeatherNow | null = null;
    try {
      let lat = useSettings.getState().weatherLat;
      let lon = useSettings.getState().weatherLon;
      /*
       * 首次使用（坐标还是默认上海）就先做一次 IP 定位 —— 别让人看到「上海」以为是假的。
       * 失败就按原坐标继续，绝不阻塞天气请求；用户手动改过就不再覆盖。
       */
      if (Math.abs(lat - 31.23) < 0.01 && Math.abs(lon - 121.47) < 0.01) {
        try {
          const geo = await fetch("https://ipapi.co/json/").then((r) => r.json());
          if (typeof geo.latitude === "number" && typeof geo.longitude === "number") {
            lat = geo.latitude;
            lon = geo.longitude;
            useSettings.getState().setWeatherPlace(String(geo.city ?? geo.region ?? "本地"), lat, lon);
          }
        } catch { /* 定位失败按原坐标继续 */ }
      }
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=4`;
      const reply = await fetch(url).then((r) => r.json());
      data = {
        temp: Math.round(reply.current.temperature_2m),
        code: reply.current.weather_code,
        wind: Math.round(reply.current.wind_speed_10m),
        days: (reply.daily.time as string[]).map((date, i) => ({
          date,
          max: Math.round(reply.daily.temperature_2m_max[i]),
          min: Math.round(reply.daily.temperature_2m_min[i]),
          code: reply.daily.weather_code[i],
        })),
      };
      weatherCache = { at: Date.now(), data };
    } catch { data = null; }
    weatherLoading = false;
    for (const waiter of weatherWaiters.splice(0)) waiter(data);
  })();
  return new Promise((resolve) => weatherWaiters.push(resolve));
}

/** 主页的天气卡：同一份缓存，小块展示（点卡片进天气页看详情）。 */
function WeatherCardBody() {
  const { t } = useTranslation();
  const [data, setData] = useState<WeatherNow | null>(weatherCache?.data ?? null);
  useEffect(() => {
    void ensureWeather().then((next) => next && setData(next));
  }, []);
  return (
    <>
      <span className="tt"><CloudSun />{t("dockFloat.tab.weather")}</span>
      <span className="mid">
        <span className="big">{data ? `${data.temp}°` : "…"}</span>
        <span className="unit">{data ? t(`dockFloat.weatherCode.${data.code}`) : t("dockFloat.weatherLoading")}</span>
      </span>
      <span className="pv">{data ? `${data.wind} km/h · ${useSettings.getState().weatherCity}` : t("dockFloat.weatherLoading")}</span>
    </>
  );
}

function WeatherPanel() {
  const { t } = useTranslation();
  const [data, setData] = useState<WeatherNow | null>(weatherCache?.data ?? null);

  useEffect(() => {
    void ensureWeather().then((next) => next && setData(next));
  }, []);

  if (!data) return <p className="df-hint">{t("dockFloat.weatherLoading")}</p>;

  return (
    <div className="df-panel df-weather">
      <div className="df-weather-now">
        <span className="df-weather-temp">{data.temp}°</span>
        <span className="df-row-meta">{t(`dockFloat.weatherCode.${data.code}`)} · {data.wind} km/h</span>
      </div>
      <p className="df-hint">{useSettings.getState().weatherCity}</p>
      <div className="df-weather-days">
        {data.days.map((day, index) => (
          <div key={day.date} className="df-weather-day">
            <span>{index === 0 ? t("dockFloat.today") : day.date.slice(5)}</span>
            <span className="df-row-meta">{day.max}° / {day.min}°</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 通知：两段 —— 云台自己的提醒聚合 + Windows 通知中心。
 *
 * 云台段汇总逾期任务、今天剩余、未来两天到期的，点一条跳到计划页。
 * 系统段走 Rust 的 UserNotificationListener（只读、不弹 toast）：
 * 未授权时**只渲染一个可点击的授权提示**，绝不因为 WinRT 报错让整页崩掉。
 */
function NoticePanel({ onOpenPlans }: { onOpenPlans: () => void }) {
  const { t, i18n } = useTranslation();
  const days = usePlans((state) => state.days);
  const today = dateKey(new Date());
  const soonKey = dateKey(new Date(Date.now() + 2 * 86_400_000));
  const rows = useMemo(() => {
    const output: { id: string; title: string; meta: string; late: boolean }[] = [];
    for (const [day, tasks] of Object.entries(days)) {
      for (const task of tasks) {
        if (task.done || task.parentId) continue;
        const late = day < today;
        // 未来两天内要到期的也算「需要注意」，否则通知页大部分时候是空的
        const soon = day > today && day <= soonKey;
        if (!late && !soon && day !== today) continue;
        output.push({ id: task.id, title: task.title, meta: day, late });
      }
    }
    return output.sort((a, b) => (a.late === b.late ? a.meta.localeCompare(b.meta) : a.late ? -1 : 1)).slice(0, 20);
  }, [days, today, soonKey]);

  const [system, setSystem] = useState<SystemNotificationSnapshot | null>(null);
  const [systemLoading, setSystemLoading] = useState(true);
  const loadSystem = useCallback(async () => {
    setSystemLoading(true);
    try {
      const snapshot = await systemNotifications();
      setSystem(snapshot && typeof snapshot.access === "string"
        ? snapshot
        : { access: "unsupported", items: [], detail: "empty snapshot" });
    } catch (error) {
      setSystem({ access: "unsupported", items: [], detail: String(error) });
    } finally {
      setSystemLoading(false);
    }
  }, []);

  useEffect(() => { void loadSystem(); }, [loadSystem]);

  const formatWhen = useCallback((value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(i18n.language === "zh" ? "zh-CN" : "en-US", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).format(date);
  }, [i18n.language]);

  const allowed = system?.access === "allowed";
  const systemItems = system?.items ?? [];
  return (
    <div className="df-panel df-notice">
      <section className="df-notice-section">
        <div className="df-notice-head">
          <span>{t("dockFloat.noticeCloud")}</span>
          <span className="df-row-meta">{t("dockFloat.calendarCount", { count: rows.length })}</span>
        </div>
        {rows.length === 0 ? (
          <p className="df-hint">{t("dockFloat.noticeEmpty")}</p>
        ) : rows.map((row) => (
          <button key={row.id} type="button" className="df-news-row" onClick={onOpenPlans}>
            <span className="df-row-title">{row.title}</span>
            <span className="df-row-meta">{row.late ? t("dockFloat.noticeLate") : row.meta}</span>
          </button>
        ))}
      </section>

      <section className="df-notice-section">
        <div className="df-notice-head">
          <span>{t("dockFloat.noticeSystem")}</span>
          {allowed && (
            <button type="button" className="df-icon-btn" aria-label={t("dockFloat.noticeRefresh")}
              title={t("dockFloat.noticeRefresh")} onClick={() => void loadSystem()}>
              <RefreshCw className="df-icon" aria-hidden="true" />
            </button>
          )}
        </div>
        {systemLoading ? (
          <p className="df-hint">{t("dockFloat.noticeSystemLoading")}</p>
        ) : allowed ? (
          systemItems.length === 0 ? (
            <p className="df-hint">{t("dockFloat.noticeSystemEmpty")}</p>
          ) : systemItems.map((item) => (
            <div key={`${item.appName}-${item.id}`} className="df-notice-sys">
              <span className="df-row-title">{item.title || item.appName}</span>
              <span className="df-row-meta">{item.appName} · {formatWhen(item.createdAt)}</span>
              {item.body && <span className="df-notice-body">{item.body}</span>}
            </div>
          ))
        ) : (
          <button type="button" data-notice-permission className="df-notice-permission"
            onClick={() => { void openNotificationSettings().catch(report); }}>
            <Bell className="df-icon" aria-hidden="true" />
            <span className="df-notice-permission-main">
              <span>{t("dockFloat.noticePermissionAction")}</span>
              <span>{system?.access === "unsupported"
                ? t("dockFloat.noticeUnsupported")
                : t("dockFloat.noticePermissionHint")}</span>
            </span>
          </button>
        )}
      </section>
    </div>
  );
}

/**
 * 终端：在卡片里一键把系统终端叫起来（Windows Terminal 优先）。
 *
 * 这一版**不嵌 PTY** —— 嵌入要 portable-pty + xterm.js + 会话生命周期，
 * 属于另一件事。先把「打开就到当前项目目录」这条最常用的路径打通。
 */
function TerminalPanel() {
  const { t } = useTranslation();
  const [cwd, setCwd] = useState<string>("");

  const launch = (kind: string) => {
    void invoke("shell_launch", { kind, cwd: cwd || null }).catch(report);
  };

  return (
    <div className="df-panel df-term">
      <label className="df-term-field">
        <span className="df-row-meta">{t("dockFloat.termDir")}</span>
        <input className="df-term-input" value={cwd} placeholder={t("dockFloat.termDirPlaceholder")}
          onChange={(event) => setCwd(event.target.value)} />
      </label>
      <div className="df-term-actions">
        {["wt", "powershell", "cmd"].map((kind) => (
          <button key={kind} type="button" className="df-pill" onClick={() => launch(kind)}>
            {kind === "wt" ? t("dockFloat.termWt") : kind === "powershell" ? "PowerShell" : "cmd"}
          </button>
        ))}
      </div>
    </div>
  );
}

