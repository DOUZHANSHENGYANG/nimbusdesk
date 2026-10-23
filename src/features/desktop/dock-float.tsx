import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { CalendarDays, ChevronDown, Inbox, ListTodo, Newspaper, Search, Settings2 } from "lucide-react";
import { CaptureForm } from "@/features/knowledge/capture";
import { usePlans } from "@/features/plans/store";
import { todayStr } from "@/features/plans/types";
import { openSearchResult, searchQuery } from "@/features/search/api";
import type { SearchHit } from "@/features/search/types";
import { mergedSources } from "@/sources/custom";
import { useFeeds } from "@/stores/feeds";
import { openUrl } from "@/lib/tauri";
import { ageBucket, childProgress, dateKey, monthGrid, summarizeDay } from "./dock-float-core";
import "./dock-float.css";

type DockTab = "search" | "plan" | "collect" | "cal" | "news";

const TABS: { key: DockTab; icon: typeof Search }[] = [
  { key: "search", icon: Search },
  { key: "plan", icon: ListTodo },
  { key: "collect", icon: Inbox },
  { key: "cal", icon: CalendarDays },
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
export function DockFloat({ onExpand, onHide }: { onExpand: (open: boolean) => Promise<void>; onHide: () => void }) {
  const { t } = useTranslation();
  const today = todayStr();
  const tasks = usePlans((state) => state.days[today]) ?? [];
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DockTab>("search");
  const summary = useMemo(() => summarizeDay(tasks), [tasks]);
  const [clock, setClock] = useState(() => dateKey(new Date()).slice(0, 0) + new Date().toTimeString().slice(0, 5));

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
            {tab === "plan" && <PlanPanel />}
            {tab === "collect" && (
              <div className="df-collect"><CaptureForm onHide={() => setExpanded(false)} /></div>
            )}
            {tab === "cal" && <CalPanel />}
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

/** 搜索：输入即搜，分组给前几条；点一条直接打开（文件用默认程序、网址用浏览器）。 */
function SearchPanel() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const needle = query.trim();
    if (!needle) { setHits([]); setBusy(false); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      setBusy(true);
      searchQuery(needle, "all", true)
        .then((reply) => { if (!cancelled) setHits(reply.results.slice(0, 8)); })
        .catch(() => { if (!cancelled) setHits([]); })
        .finally(() => { if (!cancelled) setBusy(false); });
    }, 220);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  const groups = useMemo(() => {
    const map = new Map<string, SearchHit[]>();
    for (const hit of hits) map.set(hit.kind, [...(map.get(hit.kind) ?? []), hit]);
    return [...map.entries()];
  }, [hits]);

  return (
    <div className="df-panel">
      <label className="df-field">
        <Search className="df-icon" aria-hidden="true" />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder={t("dockFloat.searchPlaceholder")} aria-label={t("dockFloat.tab.search")} />
      </label>
      {busy && <p className="df-hint">{t("dockFloat.searching")}</p>}
      {!busy && query.trim() && hits.length === 0 && <p className="df-hint">{t("dockFloat.noResult")}</p>}
      {groups.map(([kind, items]) => (
        <div key={kind} className="df-group">
          <span className="df-group-label">{t(`dockFloat.kind.${kind}`, { defaultValue: kind })}</span>
          {items.map((hit) => (
            <button key={hit.id} type="button" className="df-row" title={hit.subtitle || hit.path || hit.url || ""}
              onClick={() => openSearchResult(hit).catch(report)}>
              <span className="df-row-title">{hit.title}</span>
              <span className="df-row-meta">{hit.subtitle || hit.path || hit.url || ""}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** 计划待办：今天的顶层任务，勾选就地完成；子任务只出角标，编辑跳主窗口。 */
function PlanPanel() {
  const { t } = useTranslation();
  const date = todayStr();
  const tasks = usePlans((state) => state.days[date]) ?? [];
  const toggleDone = usePlans((state) => state.toggleDone);
  const addTask = usePlans((state) => state.addTask);
  const [draft, setDraft] = useState("");
  const summary = useMemo(() => summarizeDay(tasks), [tasks]);
  const tops = useMemo(
    () => tasks.filter((task) => !task.parentId).sort((a, b) => Number(a.done) - Number(b.done)),
    [tasks],
  );

  return (
    <div className="df-panel">
      <div className="df-stats">
        <span className="df-stat-box"><b>{summary.total}</b>{t("dockFloat.statTotal")}</span>
        <span className="df-stat-box"><b>{summary.todo}</b>{t("dockFloat.statTodo")}</span>
        <span className="df-stat-box is-warn"><b>{summary.late}</b>{t("dockFloat.statLate")}</span>
        <span className="df-stat-box is-good"><b>{summary.done}</b>{t("dockFloat.statDone")}</span>
      </div>
      <form className="df-add" onSubmit={(event) => {
        event.preventDefault();
        const title = draft.trim();
        if (!title) return;
        addTask(date, null, title);
        setDraft("");
      }}>
        <input value={draft} maxLength={200} onChange={(event) => setDraft(event.target.value)}
          placeholder={t("dockFloat.addPlaceholder")} aria-label={t("dockFloat.addPlaceholder")} />
      </form>
      {tops.length === 0
        ? <p className="df-hint">{t("dockFloat.planEmpty")}</p>
        : <div className="df-rows">
            {tops.map((task) => {
              const kids = childProgress(tasks, task.id);
              return (
                <button key={task.id} type="button" className={`df-row is-task${task.done ? " is-done" : ""}`}
                  onClick={() => toggleDone(date, task.id)} aria-pressed={task.done}>
                  <span className={`df-cb${task.done ? " is-on" : ""}`} aria-hidden="true" />
                  <span className="df-row-body">
                    <span className="df-row-title">{task.title}</span>
                    <span className="df-row-meta">
                      {task.start && <span>{task.start}</span>}
                      {kids && <span>{t("dockFloat.subtasks", { done: kids.done, total: kids.total })}</span>}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>}
    </div>
  );
}

/** 日历：固定 6 行 42 格，点一天看那天的安排；新建与改期跳主窗口。 */
function CalPanel() {
  const { t } = useTranslation();
  const days = usePlans((state) => state.days);
  const [cursor, setCursor] = useState(() => new Date());
  const [selected, setSelected] = useState(() => todayStr());
  const cells = useMemo(() => monthGrid(cursor.getFullYear(), cursor.getMonth()), [cursor]);
  const agenda = (days[selected] ?? []).filter((task) => !task.parentId).slice(0, 6);
  const planned = useMemo(() => new Set(Object.keys(days).filter((key) => (days[key] ?? []).length > 0)), [days]);

  return (
    <div className="df-panel df-cal">
      <div className="df-cal-head">
        <button type="button" className="df-icon-btn" aria-label={t("dockFloat.prevMonth")}
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
          <ChevronDown className="df-icon is-left" aria-hidden="true" />
        </button>
        <span className="df-cal-title">{t("dockFloat.monthTitle", { month: cursor.getMonth() + 1 })}</span>
        <button type="button" className="df-icon-btn" aria-label={t("dockFloat.nextMonth")}
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
          <ChevronDown className="df-icon is-right" aria-hidden="true" />
        </button>
        <span className="df-sp" />
        <button type="button" className="df-chip" onClick={() => { setCursor(new Date()); setSelected(todayStr()); }}>
          {t("dockFloat.today")}
        </button>
      </div>
      <div className="df-cal-grid">
        {["mo", "tu", "we", "th", "fr", "sa", "su"].map((day) => (
          <span key={day} className="df-cal-week">{t(`dockFloat.week.${day}`)}</span>
        ))}
        {cells.map((cell) => (
          <button key={cell.date} type="button"
            className={`df-day${cell.inMonth ? "" : " is-out"}${cell.date === selected ? " is-selected" : ""}${planned.has(cell.date) ? " has" : ""}`}
            aria-pressed={cell.date === selected} onClick={() => setSelected(cell.date)}>
            {cell.day}
          </button>
        ))}
      </div>
      <div className="df-agenda">
        <span className="df-group-label">{selected}</span>
        {agenda.length === 0
          ? <p className="df-hint">{t("dockFloat.dayEmpty")}</p>
          : agenda.map((task) => (
              <span key={task.id} className={`df-agenda-row${task.done ? " is-done" : ""}`}>
                <span className="df-row-meta">{task.start ?? ""}</span>
                <span className="df-row-title">{task.title}</span>
              </span>
            ))}
      </div>
    </div>
  );
}

/** 资讯：所有来源混排取最新，点标题用默认浏览器打开，卡片不跳走。 */
function NewsPanel() {
  const { t } = useTranslation();
  const entriesBySource = useFeeds((state) => state.entriesBySource);
  const sources = useMemo(() => mergedSources(), []);
  const items = useMemo(() => {
    const nameOf = new Map(sources.map((source) => [source.id, source.name]));
    return Object.entries(entriesBySource)
      .flatMap(([sourceId, entries]) => entries.map((entry) => ({ entry, source: nameOf.get(sourceId) ?? sourceId })))
      .sort((a, b) => (b.entry.pubDate ?? 0) - (a.entry.pubDate ?? 0))
      .slice(0, 10);
  }, [entriesBySource, sources]);

  if (items.length === 0) return <p className="df-hint">{t("dockFloat.newsEmpty")}</p>;

  return (
    <div className="df-panel df-news">
      {items.map(({ entry, source }) => {
        const age = ageBucket(entry.pubDate);
        return (
          <button key={`${source}-${entry.id}`} type="button" className="df-news-row" title={entry.url}
            onClick={() => openUrl(entry.url).catch(report)}>
            <span className="df-row-title">{entry.title}</span>
            <span className="df-row-meta">
              {source}
              {age && <span>{t(`dockFloat.age.${age.unit}`, { count: age.value })}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
