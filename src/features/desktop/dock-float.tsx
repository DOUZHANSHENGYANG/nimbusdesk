import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import {
  AppWindow, ArrowLeft, BookOpen, Bookmark, CalendarCheck, Camera, ChevronDown, ExternalLink, FileText, Folder,
  Bell, CalendarDays, CloudSun, FolderKanban, SquareTerminal, Inbox, LayoutGrid, Newspaper, Rss, Search, Send, Settings2, Sparkles, Star, Trash2,
} from "lucide-react";
import { usePlans } from "@/features/plans/store";
import { todayStr } from "@/features/plans/types";
import { openSearchResult, searchQuery } from "@/features/search/api";
import type { SearchHit } from "@/features/search/types";
import { mergedSources } from "@/sources/custom";
import type { SourceEntry } from "@/sources/types";
import { useFeeds } from "@/stores/feeds";
import { useFavorites } from "@/stores/favorites";
import { ArticleReader } from "@/features/feeds/article-reader";
import { openUrl } from "@/lib/tauri";
import { useSettings } from "@/stores/settings";
import { SchedulePage } from "@/features/schedule/page";
import { chatWithProvider, type ChatMessage } from "@/features/ai/client";
import { ageBucket, dateKey, summarizeDay } from "./dock-float-core";
import "./dock-float.css";

/**
 * 六个页：搜索、收纳盒、计划、项目、收集、资讯。
 *
 * 收纳盒 / 计划 / 项目 是侧栏形态里那三个飞出面板**本体**，由 dock.tsx 注入 ——
 * 卡片不重写它们，否则同一功能会出现两套实现、两套密度、两套交互。
 */
type DockTab = "search" | "fences" | "plans" | "projects" | "collect" | "news" | "cal" | "chat" | "weather" | "notice" | "term";

/** 胶囊里的快捷图标：六个入口全在（和标签栏是两份职责，分开命名免得改错） */
const QUICK_TABS: { key: DockTab; icon: typeof Search }[] = [
  { key: "search", icon: Search },
  { key: "fences", icon: LayoutGrid },
  { key: "plans", icon: CalendarCheck },
  { key: "projects", icon: FolderKanban },
  { key: "collect", icon: Inbox },
  { key: "news", icon: Newspaper },
  { key: "cal", icon: CalendarDays },
  { key: "chat", icon: Sparkles },
  { key: "weather", icon: CloudSun },
  { key: "notice", icon: Bell },
  { key: "term", icon: SquareTerminal },
];
/** 主标签：日均用得多，图标 + 文字 */
const PRIMARY_TABS: DockTab[] = ["search", "fences", "plans", "projects", "news"];
/** 二级功能：日历 / 天气 / 通知 / 终端 —— 只出现在卡片头部的图标区 */
const TOOL_TABS: { key: DockTab; icon: typeof Search }[] = [
  { key: "cal", icon: CalendarDays },
  { key: "weather", icon: CloudSun },
  { key: "notice", icon: Bell },
  { key: "term", icon: SquareTerminal },
];

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
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DockTab>("search");
  /** 对话是「副页」而不是第七个 tab：标签已经六个，再多就挤成图标了 */
  const [chatOpen, setChatOpen] = useState(false);
  const summary = useMemo(() => summarizeDay(tasks), [tasks]);
  const [clock, setClock] = useState(() => new Date().toTimeString().slice(0, 5));
  /** 收起形态的提醒：出现 5 秒就收（对应灵动岛的配额预警） */
  const [alertOn, setAlertOn] = useState(false);
  /** 收起形态：胶囊（信息全）/ 指示条（只剩一条线，最大化窗口时最不碍事） */
  const compactStyleSetting = useSettings((state) => state.dockCompactStyle);
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
   * 卡片的挂载期比「展开」长 320ms。
   *
   * 收起时窗口在缩，如果卡片这一刻直接卸载，用户看到的是「内容先没、窗口
   * 后缩」—— 两次跳变。多留 320ms 让它在缩的过程中一起淡出，动作就合成一次。
   */
  const [mounted, setMounted] = useState(false);
  /*
   * 挂载一次之后就常驻。
   *
   * 之前每次收起 320ms 后卸载卡片，下次展开又要重新挂载收纳盒/计划/项目
   * 三个真面板 —— 那一步要读数据、建列表，正是「展开卡一下」的来源。
   * 现在只挂一次，之后靠 CSS 显隐；代价是收起时这几个面板仍在内存里。
   */
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  /**
   * 形状跟窗口共用同一条弹簧曲线。
   *
   * Rust 每帧 SetWindowPos 时顺手 emit 一个 0..1 的进度，这里直接写进 CSS
   * 变量 —— **不走 setState**：8ms 一帧的 setState 会把 React 排进每帧的
   * 同步渲染，掉帧就是从这来的。变量由合成器读，成本近乎为零。
   */
  useEffect(() => {
    const root = document.documentElement;
    let stop: (() => void) | undefined;
    void listen<number>("dock-spring-progress", (event) => {
      // 弹簧进度是「这一次动画走到哪」，与方向无关：收起时取反才是展开度
      const p = root.dataset.dfClosing === "1" ? 1 - event.payload : event.payload;
      root.style.setProperty("--df-p", String(p));
    }).then((unlisten) => { stop = unlisten; }).catch(() => undefined);
    return () => stop?.();
  }, []);

  /**
   * 静止态必须把 --df-p 明确写回 0/1。
   * 只靠动画事件的话，展开结束后若最后一帧没到 1（或事件丢失），圆角会卡在
   * 半路 —— 卡片变成一个大药丸，四角把内容裁掉，看起来像「背景透明」。
   */
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--df-card-h", String(useSettings.getState().dockCardHeight) + "px");
    root.dataset.dfClosing = open ? "0" : "1";
    const timer = setTimeout(() => {
      root.style.setProperty("--df-p", open ? "1" : "0");
    }, 480);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (summary.late <= 0) { setAlertOn(false); return; }
    setAlertOn(true);
    const timer = setTimeout(() => setAlertOn(false), 5000);
    return () => clearTimeout(timer);
  }, [summary.late]);

  const setExpanded = useCallback((next: boolean) => {
    if (!next) suppressHoverUntil.current = Date.now() + 700;
    if (next) {
      // 并行：窗口摆放是「一帧」的，不必等它；等它反而把展开拖成两拍
      void onExpand(true).catch(report);
      setOpen(true);
      return;
    }
    // 收起：内容先淡出 180ms，之后才缩窗口
    setOpen(false);
    window.setTimeout(() => { void onExpand(false).catch(report); }, 180);
  }, [onExpand]);

  /**
   * 悬停展开、移开收起、Esc 收起 —— 这是「灵动岛」的手感来源。
   *
   * 两个细节：移入有 120ms 迟滞（路过不算），移出有 500ms 缓冲（去点面板
   * 的路上不会自己关）；焦点还在卡片里（比如正在搜索框打字）时不移出收起。
   */
  const hoverTimer = useRef<number | null>(null);
  /** 刚被显式收起时短暂忽略悬停：否则点「收起」那一刻指针还在卡片上，会立刻又展开 */
  const suppressHoverUntil = useRef(0);
  const clearHoverTimer = () => {
    if (hoverTimer.current !== null) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null; }
  };
  const hoverExpand = () => {
    if (Date.now() < suppressHoverUntil.current) return;
    clearHoverTimer();
    hoverTimer.current = window.setTimeout(() => setExpanded(true), 120);
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


  return (
    <div className="df-root" data-open={open}
      onPointerEnter={hoverExpand} onPointerLeave={hoverCollapse}>
      {compactStyle === "line" ? (
        <div className="df-line" data-open={open}
          onPointerDown={(event) => { if (event.button === 0) setExpanded(true); }}>
          <span className={summary.late > 0 ? "df-line-bar is-warn" : "df-line-bar"} />
        </div>
      ) : (
      <div className="df-capsule" data-open={open}
          data-drag
          onPointerDown={(event) => {
            // 空白处/文字上按住就拖走；图标按钮照常点击
            if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
            const win = getCurrentWebviewWindow();
            void (async () => {
              await win.startDragging();
              const pos = await win.outerPosition();
              const monitor = await import("@tauri-apps/api/window").then((m) => m.currentMonitor());
              const scale = monitor?.scaleFactor ?? 1;
              useSettings.getState().setDockFloatX(pos.x / scale);
            })().catch(() => undefined);
          }}>
          <span className="df-orb" aria-hidden="true" />
          <span className="df-name">{t("dockFloat.title")}</span>
          <span className="df-sep" aria-hidden="true" />
          {(() => {
            const total = summary.todo + summary.done;
            const pct = total ? summary.done / total : 0;
            const c = 2 * Math.PI * 6;
            return (
              <span className="df-ring" title={t("dockFloat.ringTitle", { done: summary.done, total })}
                aria-label={t("dockFloat.ringTitle", { done: summary.done, total })}>
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <circle cx="8" cy="8" r="6" className="df-ring-bg" />
                  <circle cx="8" cy="8" r="6" className="df-ring-fg"
                    strokeDasharray={`${c * pct} ${c}`} transform="rotate(-90 8 8)" />
                </svg>
              </span>
            );
          })()}
          <span className="df-stat">
            <b>{summary.todo}</b> {t("dockFloat.todoUnit")}
            {summary.late > 0 && <> · <b className="is-warn">{summary.late}</b> {t("dockFloat.lateUnit")}</>}
          </span>
          <span className="df-clock">{clock}</span>
          {alertOn && summary.late > 0 && (
            <span className="df-alert" role="status">{t("dockFloat.lateAlert", { count: summary.late })}</span>
          )}
          <span className="df-quick">
            {QUICK_TABS.filter(({ key }) => PRIMARY_TABS.includes(key)).map(({ key, icon: Icon }) => (
              <button key={key} type="button" className="df-quick-btn" title={t(`dockFloat.tab.${key}`)}
                aria-label={t(`dockFloat.tab.${key}`)}
                onClick={() => { setTab(key); setExpanded(true); }}>
                <Icon className="df-icon" aria-hidden="true" />
              </button>
            ))}
          </span>
          <button type="button" className="df-expand" title={t("dockFloat.expand")} aria-label={t("dockFloat.expand")}
            onClick={() => setExpanded(true)}>
            <ChevronDown className="df-icon" aria-hidden="true" />
          </button>
        </div>
      )}

      {mounted && (
        <div className="df-card">
          <div className="df-head" data-card-drag
            onPointerDown={(event) => {
              // 头部空白处按住就能拖动整张卡片；按钮照常点击
              if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
              const win = getCurrentWebviewWindow();
              void (async () => {
                await win.startDragging();
                const pos = await win.outerPosition();
                const monitor = await import("@tauri-apps/api/window").then((m) => m.currentMonitor());
                useSettings.getState().setDockFloatX(pos.x / (monitor?.scaleFactor ?? 1));
              })().catch(() => undefined);
            }}>
            <span className="df-orb" aria-hidden="true" />
            <span className="df-name">{t("dockFloat.title")}</span>
            <span className="df-sep" aria-hidden="true" />
            <span className="df-stat">
              <b>{summary.todo}</b> {t("dockFloat.todoUnit")} · <b>{summary.done}</b> {t("dockFloat.doneUnit")}
            </span>
            <span className="df-head-actions">
              {/* 二级功能：只放图标，点开在卡片里就地显示 —— 省掉一整行标签 */}
              {TOOL_TABS.map(({ key, icon: Icon }) => (
                <button key={key} type="button" className="df-icon-btn" title={t(`dockFloat.tab.${key}`)}
                  aria-label={t(`dockFloat.tab.${key}`)} aria-pressed={tab === key}
                  onClick={() => setTab(key)}>
                  <Icon className="df-icon" aria-hidden="true" />
                </button>
              ))}
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
              <button type="button" className="df-icon-btn" title={t("dockFloat.collapse")}
                aria-label={t("dockFloat.collapse")} onClick={() => setExpanded(false)}>
                <ChevronDown className="df-icon is-flip" aria-hidden="true" />
              </button>
            </span>
          </div>

          {chatOpen ? (
            <div className="df-body"><ChatPanel onClose={() => setChatOpen(false)} /></div>
          ) : (
          <>
          <div className="df-tabs" role="tablist" aria-label={t("dockFloat.title")}>
            {QUICK_TABS.filter(({ key }) => PRIMARY_TABS.includes(key)).map(({ key, icon: Icon }) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key}
                className="df-tab" onClick={() => setTab(key)}>
                <Icon className="df-icon" aria-hidden="true" />
                {t(`dockFloat.tab.${key}`)}
              </button>
            ))}
          </div>

          <div className="df-body">
            {tab === "search" && <SearchPanel />}
            {tab === "fences" && <div className="df-host">{panels.fences}</div>}
            {tab === "plans" && <div className="df-host">{panels.plans}</div>}
            {tab === "projects" && <div className="df-host">{panels.projects}</div>}
            {tab === "collect" && (
              <div className="df-collect">{panels.capture}</div>
            )}
            {tab === "news" && <NewsPanel />}
            {tab === "cal" && <div className="df-embed"><SchedulePage /></div>}
            {tab === "chat" && <div className="df-body-inner"><ChatPanel onClose={() => setTab("search")} /></div>}
            {tab === "weather" && <WeatherPanel />}
            {tab === "notice" && <NoticePanel onOpenPlans={() => setTab("plans")} />}
            {tab === "term" && <TerminalPanel />}
          </div>
          </>
          )}

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
    <div className="df-panel">
      <label className="df-field">
        <Search className="df-icon" aria-hidden="true" />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder={t("dockFloat.searchPlaceholder")} aria-label={t("dockFloat.tab.search")} />
        {busy && <span className="df-row-meta">{t("dockFloat.searching")}</span>}
      </label>
      <div className="df-scopes">
        {SEARCH_SCOPES.map((key) => (
          <button key={key} type="button" className={`df-scope${scope === key ? " is-on" : ""}`}
            aria-pressed={scope === key} onClick={() => setScope(key)}>
            {t(`dockFloat.scope.${key}`)}
          </button>
        ))}
      </div>
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

function WeatherPanel() {
  const { t } = useTranslation();
  const [data, setData] = useState<WeatherNow | null>(weatherCache?.data ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (weatherCache && Date.now() - weatherCache.at < 10 * 60_000) return;
    let cancelled = false;
    void (async () => {
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
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=4`;
        const reply = await fetch(url).then((r) => r.json());
        const next: WeatherNow = {
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
        weatherCache = { at: Date.now(), data: next };
        if (!cancelled) setData(next);
      } catch (cause) { if (!cancelled) setError(String(cause)); }
    })();
    return () => { cancelled = true; };
  }, []);

  if (error) return <p className="df-hint">{t("dockFloat.weatherFailed")}</p>;
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
 * 通知：应用自己的提醒聚合。
 *
 * **不是** Windows 通知中心（那需要 WinRT UserNotificationListener + 打包权限，
 * 属于另一件事）。这里只汇总云台自己能算出来的事：逾期任务、今天剩余、
 * 未来两天要到期的。点一条跳到计划页，不在这里做编辑。
 */
function NoticePanel({ onOpenPlans }: { onOpenPlans: () => void }) {
  const { t } = useTranslation();
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

  if (!rows.length) return <p className="df-hint">{t("dockFloat.noticeEmpty")}</p>;

  return (
    <div className="df-panel df-notice">
      {rows.map((row) => (
        <button key={row.id} type="button" className="df-news-row" onClick={onOpenPlans}>
          <span className="df-row-title">{row.title}</span>
          <span className="df-row-meta">{row.late ? t("dockFloat.noticeLate") : row.meta}</span>
        </button>
      ))}
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

