import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import {
  AppWindow, ArrowLeft, BookOpen, Bookmark, CalendarCheck, ChevronDown, ExternalLink, FileText, Folder,
  FolderKanban, Inbox, LayoutGrid, Newspaper, Rss, Search, Settings2, Star,
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
  const summary = useMemo(() => summarizeDay(tasks), [tasks]);
  const [clock, setClock] = useState(() => new Date().toTimeString().slice(0, 5));

  useEffect(() => {
    const timer = setInterval(() => setClock(new Date().toTimeString().slice(0, 5)), 30_000);
    return () => clearInterval(timer);
  }, []);

  const setExpanded = useCallback((next: boolean) => {
    setOpen(next);
    void onExpand(next).catch(report);
  }, [onExpand]);

  return (
    <div className="df-root" data-open={open}>
      {!open && (
        <div className="df-capsule">
          <span className="df-orb" aria-hidden="true" />
          <span className="df-name">{t("dockFloat.title")}</span>
          <span className="df-sep" aria-hidden="true" />
          <span className="df-stat">
            <b>{summary.todo}</b> {t("dockFloat.todoUnit")}
            {summary.late > 0 && <> · <b className="is-warn">{summary.late}</b> {t("dockFloat.lateUnit")}</>}
          </span>
          <span className="df-clock">{clock}</span>
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

      {open && (
        <div className="df-card">
          <div className="df-head">
            <span className="df-orb" aria-hidden="true" />
            <span className="df-name">{t("dockFloat.title")}</span>
            <span className="df-sep" aria-hidden="true" />
            <span className="df-stat">
              <b>{summary.todo}</b> {t("dockFloat.todoUnit")} · <b>{summary.done}</b> {t("dockFloat.doneUnit")}
            </span>
            <span className="df-head-actions">
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
