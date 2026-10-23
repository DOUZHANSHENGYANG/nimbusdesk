import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { startForegroundInterval } from "@/lib/visibility";
import { I18nextProvider, useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Search, X, FileText, Folder, CalendarCheck, BookOpen, Rss, Bookmark, FolderKanban, Copy, FolderOpen, Eye, CornerDownLeft, AppWindow, Pin, PinOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ListSentinel, useIncrementalCount } from "@/components/ui/incremental-list";
import { i18n } from "@/lib/i18n";
import { applyTheme } from "@/lib/theme";
import { inTauri, readJson, windowReady } from "@/lib/tauri";
import { copyText } from "@/lib/clipboard";
import { ItemIcon } from "@/features/files/icons";
import { clearSearchRecent, openSearchResult, pinSearchResult, previewSearchResult, searchAppsStatus, searchHome, searchQuery } from "./api";
import { createRequestGate, mergeSearchHits, moveSelection, searchHitIdentity, searchHomeGroups } from "./core";
import { searchCopy } from "./copy";
import { updateSearchStatus, useSearchStore } from "./store";
import type { SearchAppsStatus, SearchHit, SearchHome, SearchKind, SearchPreview, SearchReply, SearchScope, SearchStatus } from "./types";
import "./search.css";

const scopes: SearchScope[] = ["all", "app", "file", "plan", "project", "knowledge", "feed"];
const icons = { app: AppWindow, file: FileText, folder: Folder, plan: CalendarCheck, knowledge: BookOpen, feed: Rss, bookmark: Bookmark, project: FolderKanban };

/** Standalone webview: no main-app Providers, stores or background runtimes. */
export function SearchWindow() {
  useEffect(() => {
    document.documentElement.classList.add("search-root");
    let active = true;
    async function appearance() {
      try {
        const value = await readJson<{ state?: { theme?: string; lang?: string } }>("settings");
        if (!active) return;
        applyTheme(value?.state?.theme === "light" ? "light" : "dark");
        await i18n.changeLanguage(value?.state?.lang === "en" ? "en" : "zh");
      } catch { /* Keep the initial theme; a settings read must not trap a hidden window. */ }
    }
    void appearance().finally(() => { if (active && inTauri) void windowReady().catch(() => undefined); });
    const subscription = inTauri ? listen<{ key: string }>("storage://changed", ({ payload }) => { if (payload.key === "settings") void appearance(); }) : null;
    return () => { active = false; document.documentElement.classList.remove("search-root"); void subscription?.then(stop => stop()).catch(() => undefined); };
  }, []);
  return <I18nextProvider i18n={i18n}><SearchSurface /></I18nextProvider>;
}

function SearchSurface() {
  const { i18n: language } = useTranslation();
  const c = searchCopy(language.language.startsWith("en"));
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const [composing, setComposing] = useState(false);
  const [reply, setReply] = useState<SearchReply | null>(null);
  const [home, setHome] = useState<SearchHome>({ pinned: [], recent: [] });
  const [homeReady, setHomeReady] = useState(false);
  const [homeBusy, setHomeBusy] = useState(false);
  const [apps, setApps] = useState<SearchAppsStatus | null>(null);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const homeRevision = useRef(0);
  const queryNow = useRef(query); queryNow.current = query;
  const [selected, setSelected] = useState(0);
  const [keyboardSelected, setKeyboardSelected] = useState(false);
  const selectionId = useRef<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [preview, setPreview] = useState<{ id: string; title: string; data: SearchPreview | null } | null>(null);
  const previewRevision = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const gate = useRef(createRequestGate());
  const resultsCurrent = useRef(false);
  const composingNow = useRef(false);
  const status = useSearchStore(state => state.status);
  const isHome = !query.trim();
  const groups = searchHomeGroups(home, scope);
  const hits = isHome ? [...groups.pinned, ...groups.recent] : reply?.results ?? [];
  const pinnedIds = new Set(home.pinned.map(searchHitIdentity));
  const hit = hits[selected];

  /**
   * 搜索结果分片渲染。
   *
   * 文件检索走 Everything，一次能回来上千条；以前整批铺进 DOM，键盘连按时每一帧都在
   * 重排。现在先铺一批，滚到底部续下一批；键盘导航仍然能走到全部 —— `ensureVisible`
   * 会把选中项所在的那一批补出来，`aria-activedescendant` 指向的节点因此始终存在。
   */
  const { count: visibleHits, hasMore, sentinelRef, ensureVisible } = useIncrementalCount(hits.length, {
    step: 80,
    resetKey: `${isHome ? "home" : query}|${scope}`,
  });
  useEffect(() => {
    ensureVisible(selected);
  }, [selected, ensureVisible]);

  function changeQuery(value: string) {
    resultsCurrent.current = false; gate.current.invalidate(); setQuery(value); setKeyboardSelected(false); setFailure(""); setNotice("");
    selectionId.current = undefined;
    previewRevision.current++; setPreview(null);
    if (!value.trim()) { setReply(null); setLoading(false); }
  }
  function changeScope(value: SearchScope) { if (value === scope) return; resultsCurrent.current = false; gate.current.invalidate(); setScope(value); setSelected(0); setKeyboardSelected(false); selectionId.current = undefined; previewRevision.current++; setPreview(null); }
  async function loadHome() {
    const ticket = ++homeRevision.current;
    try {
      const value = await searchHome();
      if (ticket !== homeRevision.current) return;
      setHome(value ?? { pinned: [], recent: [] }); setHomeReady(true);
      if (!queryNow.current.trim() && !composingNow.current) { resultsCurrent.current = true; setSelected(0); }
    } catch (error) { if (ticket === homeRevision.current) setFailure(String(error)); }
  }
  async function updateHome(operation: () => Promise<SearchHome>) {
    if (homeBusy || !resultsCurrent.current) return;
    const ticket = ++homeRevision.current;
    setHomeBusy(true); setFailure("");
    try { const value = await operation(); if (ticket === homeRevision.current) { setHome(value); setHomeReady(true); setSelected(0); } }
    catch (error) { if (ticket === homeRevision.current) setFailure(String(error)); }
    finally { setHomeBusy(false); }
  }
  useEffect(() => {
    const ticket = gate.current.invalidate();
    if (!query.trim() || composing) { setLoading(false); resultsCurrent.current = !composing && homeReady; return; }
    const timer = setTimeout(() => {
      setLoading(true);
      if (scope !== "all") {
        void searchQuery(query.trim(), scope).then(value => {
          if (!gate.current.current(ticket)) return;
          resultsCurrent.current = true;
          const results = mergeSearchHits(value.results);
          setReply({ ...value, results, total: Math.max(results.length, value.total - (value.results.length - results.length)) }); setSelected(Math.max(0, results.findIndex(result => searchHitIdentity(result) === selectionId.current))); setFailure("");
        }).catch(() => { if (gate.current.current(ticket)) setFailure(c.error); })
          .finally(() => { if (gate.current.current(ticket)) setLoading(false); });
        return;
      }
      let business: SearchReply | null = null;
      let files: SearchReply | null = null;
      let fileWarning = "";
      function publish() {
        if (!gate.current.current(ticket)) return;
        resultsCurrent.current = true;
        const results = mergeSearchHits(business?.results ?? [], files?.results ?? []);
        const duplicates = (business?.results.length ?? 0) + (files?.results.length ?? 0) - results.length;
        setReply({ results, total: Math.max(results.length, (business?.total ?? 0) + (files?.total ?? 0) - duplicates), indexing: !!(business?.indexing || files?.indexing), warnings: [...new Set([...(business?.warnings ?? []), ...(files?.warnings ?? []), ...(fileWarning ? [fileWarning] : [])])], elapsedMs: Math.max(business?.elapsedMs ?? 0, files?.elapsedMs ?? 0) });
        setSelected(Math.max(0, results.findIndex(result => searchHitIdentity(result) === selectionId.current)));
      }
      const fast = searchQuery(query.trim(), "all", false).then(value => { business = value; if (gate.current.current(ticket)) setFailure(""); publish(); }).catch(() => { if (gate.current.current(ticket)) setFailure(c.error); });
      const slow = searchQuery(query.trim(), "file").then(value => { files = value; publish(); }).catch(() => { fileWarning = c.fileError; if (business) publish(); });
      void Promise.allSettled([fast, slow]).then(() => { if (gate.current.current(ticket)) setLoading(false); });
    }, 100);
    return () => { clearTimeout(timer); gate.current.invalidate(); };
  }, [query, scope, composing, c.error, c.fileError, status?.lastIndexedAt, status?.files?.updatedAt, apps?.lastIndexedAt, settingsRevision, homeReady]);
  useEffect(() => {
    const update = () => { void updateSearchStatus().catch(() => undefined); void searchAppsStatus().then(setApps).catch(() => undefined); };
    const focus = () => { input.current?.focus(); update(); void loadHome(); };
    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    const blur = () => {
      clearTimeout(blurTimer);
      // Native HWND focus changes also occur inside WebView2/IME. Only dismiss
      // once the document itself has stably lost focus, outside composition.
      blurTimer = setTimeout(() => {
        if (inTauri && !document.hasFocus() && !composingNow.current) void getCurrentWebviewWindow().hide().catch(() => undefined);
      }, 180);
    };
    focus(); window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    const stopStatusPoll = startForegroundInterval(update, 3000);
    const statusSub = inTauri ? listen<SearchStatus>("search://status", event => useSearchStore.setState({ status: event.payload })) : null;
    const focusSub = inTauri ? listen("search://focus", focus) : null;
    const homeSub = inTauri ? listen("search://home", () => void loadHome()) : null;
    const appsSub = inTauri ? listen<SearchAppsStatus>("search://apps-status", event => setApps(event.payload)) : null;
    const settingsSub = inTauri ? listen<{ key: string }>("storage://changed", ({ payload }) => {
      if (payload.key !== "search-settings") return;
      resultsCurrent.current = false; gate.current.invalidate(); setReply(null); setHome({ pinned: [], recent: [] }); setHomeReady(false); previewRevision.current++; setPreview(null); setSettingsRevision(value => value + 1); void loadHome();
    }) : null;
    return () => { homeRevision.current++; window.removeEventListener("focus", focus); window.removeEventListener("blur", blur); clearTimeout(blurTimer); stopStatusPoll(); for (const sub of [statusSub, focusSub, homeSub, appsSub, settingsSub]) void sub?.then(stop => stop()).catch(() => undefined); };
  }, []);
  useEffect(() => { list.current?.querySelector(`[data-search-index="${selected}"]`)?.scrollIntoView({ block: "nearest" }); }, [selected]);
  async function hide() { if (inTauri) await getCurrentWebviewWindow().hide().catch(error => setFailure(String(error))); }
  async function activate(result: SearchHit, action: "open" | "reveal" = "open") {
    if (!resultsCurrent.current) return;
    try { await openSearchResult(result, action); setFailure(""); void loadHome(); if (action === "open") await hide(); }
    catch (error) { setFailure(String(error)); }
  }
  async function copy(result: SearchHit) { setNotice(await copyText(result.path || result.title) ? c.copied : c.copyFailed); }
  async function showPreview(result: SearchHit) {
    if (!resultsCurrent.current || !result.path || result.kind === "app") return;
    const ticket = ++previewRevision.current;
    setPreview({ id: result.id, title: result.title, data: null });
    try { const data = await previewSearchResult(result.path); if (ticket === previewRevision.current) setPreview({ id: result.id, title: result.title, data }); }
    catch { if (ticket === previewRevision.current) setPreview({ id: result.id, title: result.title, data: { kind: "unsupported" } }); }
  }
  function keydown(event: KeyboardEvent) {
    if (event.nativeEvent.isComposing || composingNow.current || event.keyCode === 229) return;
    if (event.key === "Escape") { event.preventDefault(); if (preview) { previewRevision.current++; setPreview(null); } else void hide(); return; }
    const target = event.target;
    const fromInput = target === input.current;
    const fromList = target === list.current;
    if (!fromInput && !fromList) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); setSelected(value => { const next = !keyboardSelected && event.key === "ArrowDown" ? 0 : moveSelection(value, hits.length, event.key === "ArrowDown" ? 1 : -1); selectionId.current = hits[next] ? searchHitIdentity(hits[next]) : undefined; return next; }); setKeyboardSelected(true); list.current?.focus();
    } else if (event.key === "Enter" && hit) { event.preventDefault(); void activate(hit, event.ctrlKey && hit.path ? "reveal" : "open"); }
    else if (event.key === "Tab" && !event.ctrlKey && !event.altKey) { event.preventDefault(); changeScope(scopes[(scopes.indexOf(scope) + (event.shiftKey ? scopes.length - 1 : 1)) % scopes.length]); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && keyboardSelected && hit?.path) {
      if (fromInput && input.current?.selectionStart !== input.current?.selectionEnd || window.getSelection()?.toString()) return;
      event.preventDefault(); void copy(hit);
    } else if (event.key === " " && fromList && keyboardSelected && hit?.path) { event.preventDefault(); void showPreview(hit); }
    else if (event.key === "ArrowRight" && fromList) { event.preventDefault(); list.current?.querySelector<HTMLElement>(`[data-search-index="${selected}"] button`)?.focus(); }
    else if (fromList && event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); changeQuery(query + event.key); input.current?.focus(); }
    else if (fromList && event.key === "Backspace") { event.preventDefault(); changeQuery(query.slice(0, -1)); input.current?.focus(); }
  }
  const kindLabel = (kind: SearchKind) => kind === "folder" ? c.file : kind === "project" ? (language.language.startsWith("en") ? "Project" : "项目") : kind === "bookmark" ? (language.language.startsWith("en") ? "Bookmark" : "收藏") : c[kind];

  return <main className="quick-search" onKeyDown={keydown} aria-label={c.title}>
    <header className="quick-search-inputbar" data-tauri-drag-region>
      <Search size={22} className="text-muted-foreground" aria-hidden="true" />
      <input ref={input} type="text" role="combobox" aria-label={c.title} aria-controls="quick-search-results" aria-expanded={hits.length > 0} aria-activedescendant={hit ? `search-hit-${selected}` : undefined}
        placeholder={c.placeholder} value={query} autoComplete="off" spellCheck={false}
        onChange={event => changeQuery(event.target.value)} onCompositionStart={() => { resultsCurrent.current = false; composingNow.current = true; gate.current.invalidate(); setComposing(true); }}
        onCompositionEnd={event => { composingNow.current = false; setComposing(false); changeQuery(event.currentTarget.value); }} />
      {query && <Button size="icon-sm" variant="ghost" title={c.clear} aria-label={c.clear} onClick={() => { changeQuery(""); input.current?.focus(); }}><X size={16} /></Button>}
      <button type="button" className="quick-search-escape" onClick={() => void hide()} aria-label={c.hide}>esc</button>
    </header>
    <nav className="quick-search-scopes" aria-label={c.category}>{scopes.map(item => <button type="button" key={item} aria-pressed={item === scope} onClick={() => { changeScope(item); input.current?.focus(); }}>{c[item]}</button>)}<span role="status">{loading ? c.searching : reply && query.trim() ? `${reply.total}` : ""}</span></nav>
    {(failure || reply?.warnings?.length || notice) ? <div className="quick-search-notice" role="status">{failure || notice || reply?.warnings.join(" · ")}</div> : null}
    <div className="quick-search-body">
      <div id="quick-search-results" ref={list} tabIndex={0} role="listbox" aria-label={c.title} aria-activedescendant={hit ? `search-hit-${selected}` : undefined} className="quick-search-results">
        {!hits.length && <div className="quick-search-empty"><Search size={28} strokeWidth={1.3} /><strong>{query.trim() ? loading ? c.searching : c.noResults : c.empty}</strong><p>{query.trim() ? c.tryAgain : c.emptyHint}</p></div>}
        {hits.slice(0, visibleHits).map((result, index) => { const Icon = icons[result.kind] ?? FileText; const pinned = pinnedIds.has(searchHitIdentity(result)); return <div className="quick-search-entry" key={searchHitIdentity(result)}>
          {isHome && (index === 0 || index === groups.pinned.length) && <div className="quick-search-group"><span>{index < groups.pinned.length ? c.pinned : c.recent}</span>{index >= groups.pinned.length && <Button size="sm" variant="ghost" disabled={homeBusy} onClick={() => void updateHome(clearSearchRecent)}>{c.clearRecent}</Button>}</div>}
          <div id={`search-hit-${index}`} data-search-index={index} role="option" aria-selected={index === selected} className="quick-search-result" onMouseEnter={() => { setSelected(index); setKeyboardSelected(false); selectionId.current = searchHitIdentity(result); }}>
          {(result.kind === "file" || result.kind === "folder" || result.kind === "app") && result.path
            ? <ItemIcon type={result.kind === "folder" ? "folder" : "file"} path={result.path} size={20} className="quick-search-kind-icon" />
            : <Icon size={19} strokeWidth={1.6} className="quick-search-kind-icon" aria-hidden="true" />}
          <button type="button" className="quick-search-result-main" onClick={() => void activate(result)} title={result.path || result.subtitle}>
            <span className="quick-search-result-title">{result.title}</span><span className="quick-search-result-path">{result.path || result.subtitle}</span>
            {result.snippet && <span className="quick-search-result-snippet">{result.snippet}</span>}
          </button>
          <span className="quick-search-kind">{kindLabel(result.kind)}</span>
          <div className="quick-search-actions">
            <Button variant="ghost" size="icon-xs" aria-label={pinned ? c.unpin : c.pin} title={pinned ? c.unpin : c.pin} aria-pressed={pinned} disabled={homeBusy} onClick={() => void updateHome(() => pinSearchResult(result, !pinned))}>{pinned ? <PinOff /> : <Pin />}</Button>
            {result.path && <>{result.kind !== "app" && <Button variant="ghost" size="icon-xs" aria-label={c.preview} title={c.preview} onClick={() => void showPreview(result)}><Eye /></Button>}<Button variant="ghost" size="icon-xs" aria-label={c.reveal} title={c.reveal} onClick={() => void activate(result, "reveal")}><FolderOpen /></Button></>}
            <Button variant="ghost" size="icon-xs" aria-label={c.copy} title={c.copy} onClick={() => void copy(result)}><Copy /></Button>
          </div>
        </div></div>; })}
        <ListSentinel sentinelRef={sentinelRef} hasMore={hasMore} />
      </div>
      {preview && <aside className="quick-search-preview" aria-label={c.preview}><div><strong title={preview.title}>{preview.title}</strong><Button variant="ghost" size="icon-xs" aria-label={c.closePreview} onClick={() => { previewRevision.current++; setPreview(null); }}><X /></Button></div>{!preview.data ? <p>{c.previewLoading}</p> : preview.data.kind === "text" ? <pre>{preview.data.text}</pre> : preview.data.kind === "image" && preview.data.dataUrl?.startsWith("data:image/") ? <img src={preview.data.dataUrl} alt={preview.title} /> : <p>{c.noPreview}</p>}</aside>}
    </div>
    {hit?.path && <div className="quick-search-selected-path" title={hit.path} aria-label={c.fullPath}>{hit.path}</div>}
    <footer className="quick-search-footer"><span title={apps?.error || status?.error || status?.backend}>{apps?.indexing || status?.indexing || status?.files?.running || status?.files?.nameRunning || reply?.indexing ? c.indexing : status ? `${status.count.toLocaleString()} ${c.indexed}` : c.ready}{apps && <span> · {apps.count} {c.app}</span>}{status?.backend && <span className="quick-search-backend"> · {status.backend}</span>}</span><div title={c.keyboardHint}><span><kbd>↑ ↓</kbd> {c.navigate}</span><span><CornerDownLeft size={11} /> {c.open}</span><span><kbd>Tab</kbd> {c.category}</span></div></footer>
  </main>;
}
