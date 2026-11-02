import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Sparkles, Star, RefreshCw, Plus, ExternalLink, Loader2, Trash2, Settings2, Pencil, CheckCheck, FileDown, GripVertical, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useModal } from "@/components/shell/modal-host";
import { useFeeds, FAVORITES_ID } from "@/stores/feeds";
import { useFavorites } from "@/stores/favorites";
import { useFeedNetwork } from "@/stores/feed-network";
import { mergedSources } from "@/sources/custom";
import type { SourceAdapter, SourceEntry } from "@/sources/types";
import { useSubscriptions, useFeedOrder, sourceLabel, type FeedSource } from "./subscriptions";
import { summarizeList, summarizeUrl } from "@/digest/summarize";
import { openExternal } from "@/lib/open";
import { pickFile } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { AddFeedDialog } from "./add-dialog";
import { FeedNetworkSettings } from "./network-settings";
import { ArticleReader } from "./article-reader";
import { favoriteSourceName } from "./favorite-source";
import "./feeds.css";
const KIND_KEYS: Record<string, string> = { rss: "feeds.kindRss", "cn-social": "feeds.kindSocial", searxng: "feeds.kindSearch", page: "feeds.kindPage", opencli: "feeds.kindCli" };
/**
 * 一条列表共用的拖动排序：返回逐行的处理器与「落点」信息。
 * 落点按指针在行的上半/下半决定插到前面还是后面，界面据此画一条插入线。
 */
function useDragReorder(ids: () => string[], onReorder: (ids: string[]) => void) {
    const [dragId, setDragId] = useState<string | null>(null);
    const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
    const handlers = (id: string) => ({
        draggable: true,
        onDragStart: (event: React.DragEvent) => {
            setDragId(id);
            event.dataTransfer.effectAllowed = "move";
            // 拖一条细行时浏览器会截一张缩略图，低透明度更像「拿起」而不是「贴图」
            event.dataTransfer.setDragImage(event.currentTarget as Element, 12, 16);
        },
        onDragOver: (event: React.DragEvent) => {
            if (!dragId || dragId === id) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            setDrop({ id, after: event.clientY > rect.top + rect.height / 2 });
        },
        onDragLeave: () => setDrop(current => current?.id === id ? null : current),
        onDragEnd: () => { setDragId(null); setDrop(null); },
        onDrop: (event: React.DragEvent) => {
            event.preventDefault();
            if (dragId && dragId !== id) {
                // 落点自己算：事件之间 React 可能还没重渲染，读 state 会拿到上一帧的位置
                const rect = event.currentTarget.getBoundingClientRect();
                const after = event.clientY > rect.top + rect.height / 2;
                const list = ids().filter(item => item !== dragId);
                const target = list.indexOf(id);
                if (target >= 0) {
                    list.splice(target + (after ? 1 : 0), 0, dragId);
                    onReorder(list);
                }
            }
            setDragId(null); setDrop(null);
        },
    });
    /** 目标行上的插入线；不是落点行就返回 null。 */
    const indicator = (id: string) => {
        if (!drop || drop.id !== id || dragId === id) return null;
        return <span aria-hidden className={cn("pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-brand", drop.after ? "-bottom-px" : "-top-px")} />;
    };
    return { dragId, handlers, indicator };
}

export function FeedsPage() {
    const { t } = useTranslation();
    const { confirm } = useModal();
    const location = useLocation();
    const [searchParams] = useSearchParams();
    const requestedSource = searchParams.get("source") || "";
    const requestedArticle = searchParams.get("article") || "";
    const consumedRoute = useRef("");
    const activeId = useFeeds(state => state.activeId);
    const selectSource = useFeeds(state => state.selectSource);
    const initialize = useFeeds(state => state.initialize);
    const subs = useSubscriptions(state => state.sources);
    const revision = useSubscriptions(state => state.revision);
    const loadSubs = useSubscriptions(state => state.load);
    const order = useFeedOrder(state => state.order);
    const hidden = useFeedOrder(state => state.hidden);
    const setOrder = useFeedOrder(state => state.setOrder);
    const hide = useFeedOrder(state => state.hide);
    const favCount = useFavorites(state => state.items.length);
    const [addOpen, setAddOpen] = useState(false);
    const [networkOpen, setNetworkOpen] = useState(false);
    const [manageOpen, setManageOpen] = useState(false);
    const [editing, setEditing] = useState<FeedSource | null>(null);
    const refreshAll = useFeeds(state => state.refreshAll);
    const refreshing = useFeeds(state => Object.values(state.loading).some(Boolean));
    const sources = useMemo(() => mergedSources(), [revision, order, hidden]);
    const { dragId, handlers, indicator } = useDragReorder(() => sources.map(item => item.id), setOrder);
    useEffect(() => {
        const start = () => {
            if (useFeeds.persist.hasHydrated()) void loadSubs().then(() => initialize());
        };
        const offCache = useFeeds.persist.onFinishHydration(start);
        start();
        return offCache;
    }, [initialize, loadSubs]);
    useEffect(() => {
        // 订阅源在别处被删掉（或首次加载后）时，别停在一条已经不存在的源上
        if (!useSubscriptions.getState().loaded || activeId === FAVORITES_ID) return;
        if (mergedSources().some(source => source.id === activeId)) return;
        selectSource(mergedSources()[0]?.id ?? FAVORITES_ID);
    }, [activeId, revision, selectSource]);
    useEffect(() => {
        const request = `${location.key}:${requestedSource}:${requestedArticle}`;
        if (!requestedSource && !requestedArticle) return;
        const apply = () => {
            if (consumedRoute.current === request || !useFeeds.persist.hasHydrated() || !useFavorites.persist.hasHydrated()) return;
            const state = useFeeds.getState();
            const cached = state.entriesBySource[requestedSource]?.find(item => item.url === requestedArticle);
            const favorite = useFavorites.getState().items.find(item => item.url === requestedArticle);
            const source = cached ? requestedSource : favorite ? FAVORITES_ID : requestedSource;
            if (!source || source !== FAVORITES_ID && !mergedSources().some(item => item.id === source)) return;
            consumedRoute.current = request;
            state.selectSource(source);
            state.selectEntry(cached || favorite || null);
        };
        const off = [useFeeds.persist.onFinishHydration(apply), useFavorites.persist.onFinishHydration(apply)];
        apply();
        return () => off.forEach(stop => stop());
    }, [location.key, requestedSource, requestedArticle]);
    const sourceRow = (source: SourceAdapter) => {
      const feed = subs.find(item => item.id === source.id);
      const active = activeId === source.id;
      return <div key={source.id} data-feed-row={source.id} {...handlers(source.id)}
        className={cn("group relative flex min-h-9 items-center gap-0.5 rounded-md pr-1 transition-colors", active ? "bg-brand/15 text-foreground" : "hover:bg-accent/60", dragId === source.id && "opacity-60")}>
        {indicator(source.id)}
        <GripVertical aria-hidden className="size-3 shrink-0 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
        <button type="button" onClick={() => selectSource(source.id)} title={source.name}
          aria-current={active ? "true" : undefined}
          onKeyDown={event => {
            if (!event.altKey) return;
            const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
            if (!step) return;
            event.preventDefault();
            moveLocal(source.id, step);
          }}
          className={cn("min-w-0 flex-1 truncate px-2.5 py-1.5 text-left text-[13px]", active && "font-medium")}>
          {source.name}
        </button>
        <span className="flex shrink-0 items-center opacity-40 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {feed && <button type="button" title={t("feeds.editSource")} aria-label={t("feeds.editSource") + " · " + source.name} onClick={() => setEditing(feed)} className="rounded p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Pencil className="size-3" /></button>}
          <button type="button" title={t(feed ? "feeds.removeSource" : "feeds.hideSource")} aria-label={t(feed ? "feeds.removeSource" : "feeds.hideSource") + " · " + source.name} onClick={() => void removeSource(source.id)} className="rounded p-1 text-muted-foreground outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"><Trash2 className="size-3" /></button>
        </span>
      </div>;
    };
    function moveLocal(id: string, step: number) {
        const ids = sources.map(item => item.id);
        const from = ids.indexOf(id);
        const to = from + step;
        if (from < 0 || to < 0 || to >= ids.length) return;
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        setOrder(ids);
    }
    async function removeSource(id = activeId) {
        const feed = subs.find(item => item.id === id);
        const source = sources.find(item => item.id === id);
        if (!source)
            return;
        if (!await confirm({ title: t(feed ? "feeds.removeSource" : "feeds.hideSource"), description: source.name }))
            return;
        if (feed)
            await useSubscriptions.getState().remove(feed.id);
        else
            hide(source.id);
        if (activeId === id)
            selectSource(mergedSources().find(item => item.id !== id)?.id ?? FAVORITES_ID);
    }
    async function importOpml() {
        try {
            const path = await pickFile();
            if (!path) return;
            const sources = await useSubscriptions.getState().importOpml(path);
            toast.success(t("feeds.opmlImported", { count: sources.length }));
        } catch (cause) {
            toast.error(cause instanceof Error ? cause.message : String(cause));
        }
    }
    return <div className="flex h-full min-h-0 workbench-ui">
      <aside className="hidden w-48 shrink-0 flex-col border-r md:flex" aria-label={t("feeds.sources")}>
        <ScrollArea className="min-h-0 flex-1 p-2">
          <button type="button" onClick={() => selectSource(FAVORITES_ID)} aria-current={activeId === FAVORITES_ID ? "true" : undefined} className={cn("mb-4 flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] transition-colors", activeId === FAVORITES_ID ? "bg-brand/15 font-medium text-foreground" : "hover:bg-accent/60")}>
            <Star className="size-3.5 text-warning" />{t("feeds.favorites")}<span className="ml-auto text-xs tabular-nums text-muted-foreground">{favCount}</span>
          </button>
          <section aria-label={t("feeds.sourcesList")}>
            <p className="mb-1 px-2.5 text-[11px] font-medium text-muted-foreground">{t("feeds.sourcesList")}</p>
            {sources.map(sourceRow)}
            {!sources.length && <div className="flex flex-col gap-1">
              <button type="button" onClick={() => useFeedOrder.getState().restore()} className="flex min-h-8 w-full items-center gap-1.5 rounded-md px-2.5 text-left text-[12px] text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                <RotateCcw className="size-3.5" />{t("feeds.restoreDefaults")}
              </button>
              <button type="button" onClick={() => setAddOpen(true)} className="flex min-h-8 w-full items-center gap-1.5 rounded-md px-2.5 text-left text-[12px] text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                <Plus className="size-3.5" />{t("feeds.addSource")}
              </button>
            </div>}
          </section>
        </ScrollArea>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <span className="flex-1"/>
          <Button size="sm" variant="ghost" disabled={refreshing} onClick={() => void refreshAll()}><RefreshCw className={cn("size-4", refreshing && "animate-spin")}/>{t(refreshing ? "feeds.refreshingAll" : "feeds.refreshAll")}</Button>
          <Button size="icon" variant="ghost" aria-label={t("feeds.networkTitle")} title={t("feeds.networkTitle")} onClick={() => setNetworkOpen(true)}><Settings2 className="size-4"/></Button>
          <Button size="sm" variant="ghost" onClick={() => setManageOpen(true)}>{t("feeds.manageSources")}</Button>
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}><Plus className="size-4"/>{t("feeds.addSource")}</Button>
        </header>
        <div className="border-b p-3 md:hidden">
          <label className="sr-only" htmlFor="feed-source">{t("feeds.sources")}</label>
          <select id="feed-source" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={activeId} onChange={event => selectSource(event.target.value)}>
            <option value={FAVORITES_ID}>{t("feeds.favorites")}</option>
            <optgroup label={t("feeds.sourcesList")}>{sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</optgroup>
          </select>
        </div>
        <div className="flex min-h-0 flex-1"><FlowView sources={sources} onRemove={() => void removeSource()} /></div>
      </div>
    <AddFeedDialog open={addOpen} onOpenChange={setAddOpen}/>
    <AddFeedDialog open={Boolean(editing)} onOpenChange={value => { if (!value) setEditing(null); }} source={editing ?? undefined}/>
    <Dialog open={manageOpen} onOpenChange={setManageOpen}><DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
      <DialogHeader><DialogTitle>{t("feeds.manageSources")}</DialogTitle></DialogHeader>
      <div className="max-h-[55vh] space-y-1 overflow-y-auto">
        {sources.length
          ? sources.map(source => {
            const feed = subs.find(item => item.id === source.id);
            return <div key={source.id} {...handlers(source.id)} className={cn("group relative flex min-w-0 cursor-grab items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted", dragId === source.id && "opacity-60")}>
              {indicator(source.id)}
              <GripVertical aria-hidden className="size-3 shrink-0 text-muted-foreground/40" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{source.name}<span className="ml-2 text-[11px] font-normal text-muted-foreground">{feed ? t(KIND_KEYS[feed.kind] ?? "feeds.kindRss") : t("feeds.builtin")}</span></span>
                <span className="block truncate text-[11px] text-muted-foreground">{feed ? sourceLabel(feed) : t("feeds.builtinHint")}</span>
                {feed?.lastError && <span className="block truncate text-[11px] text-destructive">{feed.lastError}</span>}
              </span>
              {feed && <Button variant="ghost" size="icon-xs" aria-label={t("feeds.editSource")} title={t("feeds.editSource")} onClick={() => { setManageOpen(false); setEditing(feed); }}><Pencil /></Button>}
              <Button variant="ghost" size="icon-xs" aria-label={t(feed ? "feeds.removeSource" : "feeds.hideSource")} title={t(feed ? "feeds.removeSource" : "feeds.hideSource")} onClick={() => {
                if (feed) {
                  void useSubscriptions.getState().remove(feed.id);
                  if (activeId === feed.id) selectSource(FAVORITES_ID);
                } else {
                  hide(source.id);
                  if (activeId === source.id) selectSource(FAVORITES_ID);
                }
              }}><Trash2 /></Button>
            </div>;
          })
          : <p className="px-2 py-1 text-[11.5px] text-muted-foreground">{t("feeds.noSubscriptions")}</p>}
      </div>
      <div className="flex flex-wrap justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => useFeedOrder.getState().restore()}><RotateCcw className="size-4" />{t("feeds.restoreDefaults")}</Button><Button size="sm" variant="ghost" onClick={() => void importOpml()}><FileDown className="size-4" />{t("feeds.importOpml")}</Button><Button size="sm" onClick={() => { setManageOpen(false); setAddOpen(true); }}><Plus className="size-4" />{t("feeds.addSource")}</Button></div>
    </DialogContent></Dialog>
    <Dialog open={networkOpen} onOpenChange={setNetworkOpen}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"><DialogTitle className="sr-only">{t("feeds.networkTitle")}</DialogTitle><div className="pt-4"><FeedNetworkSettings /></div></DialogContent></Dialog>
  </div>;
}
function subscribeWidth(callback: () => void) { const query = window.matchMedia('(min-width:1280px)'); query.addEventListener('change', callback); return () => query.removeEventListener('change', callback); }
const compactDetails = () => !window.matchMedia('(min-width:1280px)').matches;
function FlowView({ sources, onRemove }: {
    sources: SourceAdapter[];
    onRemove: () => void;
}) {
    const { t } = useTranslation();
    const activeId = useFeeds(state => state.activeId);
    const entries = useFeeds(state => state.entriesBySource[state.activeId]);
    const loading = useFeeds(state => state.loading[state.activeId]);
    const error = useFeeds(state => state.error[state.activeId]);
    const lastFetchedAt = useFeeds(state => state.lastFetchedAt[state.activeId]);
    const selected = useFeeds(state => state.selected);
    const selectEntry = useFeeds(state => state.selectEntry);
    const refresh = useFeeds(state => state.refresh);
    const favItems = useFavorites(state => state.items);
    const cache = useFeeds(state => state.entriesBySource);
    const toggleFav = useFavorites(state => state.toggle);
    const removeFav = useFavorites(state => state.remove);
    const route = useFeedNetwork(state => state.lastRoute);
    const patchItem = useSubscriptions(state => state.patchItem);
    const markAllRead = useSubscriptions(state => state.markAllRead);
    const isSubscription = useSubscriptions(state => state.sources.some(item => item.id === activeId));
    const compact = useSyncExternalStore(subscribeWidth, compactDetails, () => false);
    // 每个源第一次打开时自动看第一条：右栏不至于是一块空白（关掉后不再自动弹）。
    const autoPicked = useRef("");
    useEffect(() => {
        if (compact || selected || activeId === FAVORITES_ID || !entries?.length) return;
        if (autoPicked.current === activeId) return;
        autoPicked.current = activeId;
        selectEntry(entries[0]);
    }, [activeId, compact, entries, selectEntry, selected]);
    const [digestOpen, setDigestOpen] = useState(false);
    const [digestTitle, setDigestTitle] = useState("");
    const [digestText, setDigestText] = useState("");
    const [digestRunning, setDigestRunning] = useState(false);
    const [digestError, setDigestError] = useState("");
    const digestBusy = useRef(false);
    const digestVersion = useRef(0);
    useEffect(() => () => { digestVersion.current++; }, []);
    const favoriteSource = activeId === FAVORITES_ID;
    const name = favoriteSource ? t("feeds.favorites") : sources.find(source => source.id === activeId)?.name ?? activeId;
    const isFav = selected ? favItems.some(item => item.url === selected.url) : false;
    async function openDigest(title: string, run: (delta: (chunk: string) => void) => Promise<string>) {
        if (digestBusy.current)
            return;
        digestBusy.current = true;
        const version = ++digestVersion.current;
        setDigestTitle(title);
        setDigestText("");
        setDigestError("");
        setDigestOpen(true);
        setDigestRunning(true);
        try {
            await run(chunk => { if (version === digestVersion.current)
                setDigestText(value => value + chunk); });
        }
        catch (cause) {
            if (version === digestVersion.current)
                setDigestError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            digestBusy.current = false;
            setDigestRunning(false);
        }
    }
    function openArticle(url: string) { void openExternal(url).catch(cause => toast.error(String(cause))); }
    function markRead(entry: SourceEntry) {
        if (!entry.state || entry.state.read) return;
        const cache = useFeeds.getState();
        cache.seedCache(cache.activeId, (cache.entriesBySource[cache.activeId] ?? []).map(item => item.id === entry.id && item.state ? { ...item, state: { ...item.state, read: true } } : item));
        void patchItem(entry.state.itemId, { read: true });
    }
    const detail = selected ? (
      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t("feeds.detail")}>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ArticleReader entry={selected} sourceName={favoriteSource ? favoriteSourceName(selected, sources, cache) || t("feeds.unknownSource") : name} onOpen={openArticle} />
        </div>
        <footer className="feed-article-footer">
          <Button size="sm" onClick={() => openArticle(selected.url)}>
            <ExternalLink className="size-3.5" />{t("feeds.open")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => { toggleFav(selected, favoriteSource ? undefined : name); if (selected.state) void patchItem(selected.state.itemId, { starred: !isFav }); }} className={cn(isFav && "text-warning")}>
            <Star className={cn("size-3.5", isFav && "fill-current")} />{t(isFav ? "feeds.saved" : "feeds.save")}
          </Button>
          <Button size="sm" variant="outline" disabled={digestRunning} title={t("feeds.summarize")} aria-label={t("feeds.summarize")} onClick={() => {
            if (compact) selectEntry(null);
            void openDigest(selected.title.slice(0, 32), delta => summarizeUrl(selected.url, delta));
          }}><Sparkles className="size-3.5" /></Button>
        </footer>
      </section>
    ) : null;
    return <><section className="flex min-h-0 min-w-0 flex-1">
      <div className={cn("flex min-h-0 min-w-0 flex-col", selected && !compact ? "w-[360px] shrink-0 border-r" : "flex-1")}>
        <header className="flex items-center gap-1 border-b px-3 py-2"><div className="min-w-0 flex-1"><h2 className="truncate text-[13px] font-semibold">{name}<span className="ml-1.5 text-[11px] font-normal tabular-nums text-muted-foreground">{favoriteSource ? favItems.length : entries?.length ?? ''}</span></h2>{lastFetchedAt && !favoriteSource && <p className="text-[11px] text-muted-foreground">{t("feeds.updatedAt", { time: new Date(lastFetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}</p>}</div>{isSubscription && <Button variant="ghost" size="icon-sm" title={t("feeds.removeSource")} aria-label={t("feeds.removeSource")} onClick={onRemove}><Trash2 className="size-4"/></Button>}{!favoriteSource && <Button variant="ghost" size="icon-sm" disabled={loading} title={t("feeds.refresh")} aria-label={t("feeds.refresh")} onClick={() => void refresh()}><RefreshCw className={cn("size-4", loading && "animate-spin")}/></Button>}{isSubscription && <Button variant="ghost" size="icon-sm" title={t("feeds.markAllRead")} aria-label={t("feeds.markAllRead")} onClick={() => { void markAllRead(activeId); const cache = useFeeds.getState(); cache.seedCache(activeId, (cache.entriesBySource[activeId] ?? []).map(item => item.state ? { ...item, state: { ...item.state, read: true } } : item)); }}><CheckCheck className="size-4"/></Button>}{!favoriteSource && !!entries?.length && <Button variant="ghost" size="icon-sm" disabled={digestRunning} title={t("feeds.aiBrief")} aria-label={t("feeds.aiBrief")} onClick={() => void openDigest(`${name} · AI`, delta => summarizeList(name, entries, delta))}><Sparkles className="size-4"/></Button>}</header>
      {activeId === 'github-trending' && route && <p className="border-b px-3 py-1.5 text-[11px] leading-5 text-muted-foreground">{t("feeds.currentRoute", { name: route.name })}{route.id !== 'direct' ? ` · ${t('feeds.nonOfficial')}` : ''}</p>}
      {error && <div role="alert" className="flex flex-wrap items-center gap-2 border-b bg-destructive/5 px-3 py-2 text-xs"><p className="min-w-0 flex-1 break-words text-destructive">{!!entries?.length ? `${t('feeds.stale')} · ` : ''}{t('feeds.fetchFail')}{error}</p><Button size="xs" variant="outline" disabled={loading} onClick={() => void refresh()}>{t('feeds.retry')}</Button></div>}
      <ScrollArea className="min-h-0 flex-1">{loading && !entries?.length && !favoriteSource && <div role="status" className="flex items-center justify-center gap-2 py-14 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin"/>{t('feeds.loading')}</div>}
        {favoriteSource ? (favItems.length ? <ul className="flex flex-col gap-px p-1.5">{favItems.map(item => <li className="group flex items-center" key={item.url}><button type="button" title={`${favoriteSourceName(item, sources, cache) || t("feeds.unknownSource")} · ${item.title}`} className={cn("min-h-10 min-w-0 flex-1 truncate rounded-md px-2.5 py-2 text-left text-[13px]", selected?.url === item.url ? 'bg-accent' : 'hover:bg-accent/60')} onClick={() => selectEntry(item)} onDoubleClick={() => openArticle(item.url)}><span className="feed-favorite-source">{favoriteSourceName(item, sources, cache) || t("feeds.unknownSource")}</span><span aria-hidden="true" className="mx-1.5 text-muted-foreground/40">·</span>{item.title}</button><Button size="icon-sm" variant="ghost" aria-label={t('feeds.unfav')} onClick={() => removeFav(item.url)}><Star className="size-3.5 fill-current text-warning"/></Button></li>)}</ul> : <Empty>{t('feeds.favEmpty')}</Empty>) : entries?.length ? <ul className="flex flex-col gap-px p-1.5">{entries.map((entry, index) => <li key={entry.id || entry.url}><button type="button" onClick={() => { selectEntry(entry); markRead(entry); }} onDoubleClick={() => openArticle(entry.url)} title={entry.title} aria-pressed={selected?.url === entry.url} className={cn("grid min-h-10 w-full grid-cols-[1.1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors", selected?.url === entry.url ? 'bg-accent' : 'hover:bg-accent/60')}><span className={cn("text-right text-[11px] tabular-nums", entry.state && !entry.state.read ? "text-brand" : "text-muted-foreground")}>{entry.state && !entry.state.read ? "●" : index + 1}</span><span className="truncate">{entry.title}</span><span className="max-w-[6.5rem] truncate text-[11px] tabular-nums text-muted-foreground">{entry.extra?.info ?? ""}</span></button></li>)}</ul> : !loading && !error ? <Empty>{t('feeds.noResult')}</Empty> : null}
      </ScrollArea>
      </div>
      {!compact && selected && <div className="flex min-w-0 flex-1 flex-col">{detail}</div>}
    </section>
    {compact && selected && <Dialog open onOpenChange={open => { if (!open)
        selectEntry(null); }}><DialogContent className="flex h-[86vh] max-h-[900px] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"><DialogTitle className="sr-only">{selected.title}</DialogTitle><div className="flex min-h-0 flex-1 flex-col">{detail}</div></DialogContent></Dialog>}
    <Dialog open={digestOpen} onOpenChange={open => { setDigestOpen(open); if (!open)
        digestVersion.current++; }}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle className="truncate pr-6 text-sm">{digestTitle}</DialogTitle></DialogHeader><ScrollArea className="max-h-[60vh]">{digestError && <p role="alert" className="text-sm text-destructive">{digestError}</p>}{!digestError && !digestText && digestRunning && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin"/>{t('feeds.aiReading')}</p>}{digestText && <div className="whitespace-pre-wrap text-sm leading-relaxed">{digestText}</div>}</ScrollArea></DialogContent></Dialog>
  </>;
}
function Empty({ children }: {
    children: React.ReactNode;
}) { return <div className="flex min-h-40 items-center justify-center px-4 text-center text-sm text-muted-foreground">{children}</div>; }
