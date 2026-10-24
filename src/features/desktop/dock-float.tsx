import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import {
  AppWindow, ArrowLeft, BookOpen, Bookmark, CalendarCheck, Camera, ChevronDown, ExternalLink, FileText, Folder,
  FolderKanban, Inbox, LayoutGrid, Newspaper, Rss, Search, Send, Settings2, Sparkles, Star, Trash2,
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
import { chatWithProvider, type ChatMessage } from "@/features/ai/client";
import { ageBucket, summarizeDay } from "./dock-float-core";
import "./dock-float.css";

/**
 * 六个页：搜索、收纳盒、计划、项目、收集、资讯。
 *
 * 收纳盒 / 计划 / 项目 是侧栏形态里那三个飞出面板**本体**，由 dock.tsx 注入 ——
 * 卡片不重写它们，否则同一功能会出现两套实现、两套密度、两套交互。
 */
type DockTab = "search" | "fences" | "plans" | "projects" | "collect" | "news";

const TABS: { key: DockTab; icon: typeof Search }[] = [
  { key: "search", icon: Search },
  { key: "fences", icon: LayoutGrid },
  { key: "plans", icon: CalendarCheck },
  { key: "projects", icon: FolderKanban },
  { key: "collect", icon: Inbox },
  { key: "news", icon: Newspaper },
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
  onExpand: (open: boolean) => Promise<void>;
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
  useEffect(() => {
    if (open) { setMounted(true); return; }
    const timer = setTimeout(() => setMounted(false), 320);
    return () => clearTimeout(timer);
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
    setOpen(next);
    void onExpand(next).catch(report);
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
            {TABS.map(({ key, icon: Icon }) => (
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
          <div className="df-head">
            <span className="df-orb" aria-hidden="true" />
            <span className="df-name">{t("dockFloat.title")}</span>
            <span className="df-sep" aria-hidden="true" />
            <span className="df-stat">
              <b>{summary.todo}</b> {t("dockFloat.todoUnit")} · <b>{summary.done}</b> {t("dockFloat.doneUnit")}
            </span>
            <span className="df-head-actions">
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
            {TABS.map(({ key, icon: Icon }) => (
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
