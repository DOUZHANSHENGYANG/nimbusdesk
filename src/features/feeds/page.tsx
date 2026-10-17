import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, Star, RefreshCw, Plus, ExternalLink, Loader2, Trash2, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useModal } from "@/components/shell/modal-host";
import { useFeeds, FAVORITES_ID } from "@/stores/feeds";
import { useFavorites } from "@/stores/favorites";
import { useCustomFeeds } from "@/stores/custom-feeds";
import { useFeedNetwork } from "@/stores/feed-network";
import { mergedSources } from "@/sources/custom";
import type { SourceAdapter } from "@/sources/types";
import { summarizeList, summarizeUrl } from "@/digest/summarize";
import { openExternal } from "@/lib/open";
import { cn } from "@/lib/utils";
import { AddFeedDialog } from "./add-dialog";
import { AiSearchView } from "./ai-search";
import { FeedNetworkSettings } from "./network-settings";
import { ArticleReader } from "./article-reader";
import { favoriteSourceName } from "./favorite-source";
import "./feeds.css";
const GROUP_KEYS: Record<string, string> = { 技术: "feeds.groupTech", 资讯: "feeds.groupMedia", 社区: "feeds.groupCommunity", 订阅: "feeds.groupSub" };
export function FeedsPage() {
    const { t } = useTranslation();
    const { confirm } = useModal();
    const activeId = useFeeds(state => state.activeId);
    const selectSource = useFeeds(state => state.selectSource);
    const initialize = useFeeds(state => state.initialize);
    const customFeeds = useCustomFeeds(state => state.feeds);
    const favCount = useFavorites(state => state.items.length);
    const [addOpen, setAddOpen] = useState(false);
    const [networkOpen, setNetworkOpen] = useState(false);
    const [mode, setMode] = useState("flow");
    const refreshAll = useFeeds(state => state.refreshAll);
    const refreshing = useFeeds(state => Object.values(state.loading).some(Boolean));
    const sources = useMemo(() => mergedSources(), [customFeeds]);
    const subscriptions = sources.filter(source => customFeeds.some(feed => feed.id === source.id));
    const builtins = sources.filter(source => !subscriptions.includes(source));
    const groups = [...new Set(builtins.map(source => source.group))];
    const subscriptionGroups = [...new Set(subscriptions.map(source => source.group))];
    const groupName = (group: string) => GROUP_KEYS[group] ? t(GROUP_KEYS[group]) : group;
    useEffect(() => {
        const start = () => {
            if (useCustomFeeds.persist.hasHydrated() && useFeeds.persist.hasHydrated()) void initialize();
        };
        const offFeeds = useCustomFeeds.persist.onFinishHydration(start);
        const offCache = useFeeds.persist.onFinishHydration(start);
        start();
        return () => { offFeeds(); offCache(); };
    }, [initialize]);
    const sourceButton = (source: SourceAdapter) => (
      <button type="button" key={source.id} onClick={() => selectSource(source.id)} title={source.name}
        aria-current={activeId === source.id ? "true" : undefined}
        className={cn("block min-h-9 w-full truncate rounded-md px-2.5 text-left text-[13px]", activeId === source.id ? "bg-accent font-medium" : "hover:bg-accent/60")}>
        {source.name}
      </button>
    );
    async function removeSource() {
        const source = customFeeds.find(feed => feed.id === activeId);
        if (!source)
            return;
        if (!await confirm({ title: t("feeds.removeSource"), description: source.name }))
            return;
        useCustomFeeds.getState().remove(source.id);
        selectSource(sources.find(item => item.id !== source.id)?.id ?? FAVORITES_ID);
    }
    return <div className="flex h-full min-h-0 flex-col workbench-ui">
    <Tabs value={mode} onValueChange={setMode} className="flex min-h-0 flex-1 flex-col gap-0">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <TabsList className="feed-mode-switch" data-mode={mode} aria-label={t("feeds.viewMode")}><TabsTrigger value="flow">{t("feeds.tabFlow")}</TabsTrigger><TabsTrigger value="ai">{t("feeds.tabAi")}</TabsTrigger></TabsList>
        <span className="flex-1"/>
        {mode === "flow" && <Button size="sm" variant="ghost" disabled={refreshing} onClick={() => void refreshAll()}><RefreshCw className={cn("size-4", refreshing && "animate-spin")}/>{t(refreshing ? "feeds.refreshingAll" : "feeds.refreshAll")}</Button>}
        <Button size="icon" variant="ghost" aria-label={t("feeds.networkTitle")} title={t("feeds.networkTitle")} onClick={() => setNetworkOpen(true)}><Settings2 className="size-4"/></Button>
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}><Plus className="size-4"/>{t("feeds.addSource")}</Button>
      </header>
      <TabsContent value="flow" className="mt-0 min-h-0 flex-1">
        <div className="flex h-full min-h-0">
          <aside className="hidden w-44 shrink-0 flex-col border-r md:flex" aria-label={t("feeds.sources")}>
            <ScrollArea className="min-h-0 flex-1 p-2">
              <button type="button" onClick={() => selectSource(FAVORITES_ID)} aria-current={activeId === FAVORITES_ID ? "true" : undefined} className={cn("mb-4 flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px]", activeId === FAVORITES_ID ? "bg-accent font-medium" : "hover:bg-accent/60")}>
                <Star className="size-3.5 text-warning" />{t("feeds.favorites")}<span className="ml-auto text-xs tabular-nums text-muted-foreground">{favCount}</span>
              </button>
              {!!subscriptions.length && <section className="mb-4" aria-label={t("feeds.mySubscriptions")}>
                <p className="mb-1 px-2.5 text-[11px] font-medium text-muted-foreground">{t("feeds.mySubscriptions")}</p>
                {subscriptionGroups.map(group => <div key={group}>
                  {(subscriptionGroups.length > 1 || group !== "订阅") && <p className="mt-2 px-2.5 text-[11px] text-muted-foreground">{groupName(group)}</p>}
                  {subscriptions.filter(source => source.group === group).map(sourceButton)}
                </div>)}
              </section>}
              {groups.map(group => <div key={group} className="mb-4">
                <p className="mb-1 px-2.5 text-[11px] text-muted-foreground">{groupName(group)}</p>
                {builtins.filter(source => source.group === group).map(sourceButton)}
              </div>)}
            </ScrollArea>
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="border-b p-3 md:hidden">
              <label className="sr-only" htmlFor="feed-source">{t("feeds.sources")}</label>
              <select id="feed-source" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={activeId} onChange={event => selectSource(event.target.value)}>
                <option value={FAVORITES_ID}>{t("feeds.favorites")}</option>
                {!!subscriptions.length && <optgroup label={t("feeds.mySubscriptions")}>{subscriptions.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</optgroup>}
                {groups.map(group => <optgroup key={group} label={groupName(group)}>{builtins.filter(source => source.group === group).map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</optgroup>)}
              </select>
            </div>
            <div className="flex min-h-0 flex-1"><FlowView sources={sources} onRemove={() => void removeSource()} /></div>
          </div>
        </div>
      </TabsContent>
      <TabsContent value="ai" className="mt-0 min-h-0 flex-1"><AiSearchView /></TabsContent>
    </Tabs>
    <AddFeedDialog open={addOpen} onOpenChange={setAddOpen}/>
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
    const compact = useSyncExternalStore(subscribeWidth, compactDetails, () => false);
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
    const detail = selected ? (
      <section className="flex min-h-0 flex-1 flex-col" aria-label={t("feeds.detail")}>
        <ScrollArea className="min-h-0 flex-1">
          <ArticleReader entry={selected} sourceName={favoriteSource ? favoriteSourceName(selected, sources, cache) || t("feeds.unknownSource") : name} onOpen={openArticle} />
        </ScrollArea>
        <footer className="feed-article-footer">
          <Button size="sm" onClick={() => openArticle(selected.url)}>
            <ExternalLink className="size-3.5" />{t("feeds.open")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => toggleFav(selected, favoriteSource ? undefined : name)} className={cn(isFav && "text-warning")}>
            <Star className={cn("size-3.5", isFav && "fill-current")} />{t(isFav ? "feeds.saved" : "feeds.save")}
          </Button>
          <Button size="sm" variant="outline" disabled={digestRunning} title={t("feeds.summarize")} aria-label={t("feeds.summarize")} onClick={() => {
            if (compact) selectEntry(null);
            void openDigest(selected.title.slice(0, 32), delta => summarizeUrl(selected.url, delta));
          }}><Sparkles className="size-3.5" /></Button>
        </footer>
      </section>
    ) : null;
    return <><main className="flex min-w-0 flex-1 flex-col"><header className="flex flex-wrap items-center gap-2 border-b px-4 py-3"><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold">{name}<span className="ml-2 text-xs font-normal tabular-nums text-muted-foreground">{favoriteSource ? favItems.length : entries?.length ?? ''}</span></h2>{lastFetchedAt && !favoriteSource && <p className="mt-1 text-[11px] text-muted-foreground">{t("feeds.updatedAt", { time: new Date(lastFetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}</p>}</div>{activeId.startsWith('rss:') && <Button variant="ghost" size="icon" title={t("feeds.removeSource")} aria-label={t("feeds.removeSource")} onClick={onRemove}><Trash2 className="size-4"/></Button>}{!favoriteSource && <Button variant="ghost" size="icon" disabled={loading} title={t("feeds.refresh")} aria-label={t("feeds.refresh")} onClick={() => void refresh()}><RefreshCw className={cn("size-4", loading && "animate-spin")}/></Button>}{!favoriteSource && !!entries?.length && <Button variant="ghost" size="icon" disabled={digestRunning} title={t("feeds.aiBrief")} aria-label={t("feeds.aiBrief")} onClick={() => void openDigest(`${name} · AI`, delta => summarizeList(name, entries, delta))}><Sparkles className="size-4"/></Button>}</header>
      {activeId === 'github-trending' && route && <p className="border-b px-4 py-2 text-[11px] leading-5 text-muted-foreground">{t("feeds.currentRoute", { name: route.name })}{route.id !== 'direct' ? ` · ${t('feeds.nonOfficial')}` : ''}</p>}
      {error && <div role="alert" className="flex flex-wrap items-center gap-2 border-b bg-destructive/5 px-4 py-3 text-xs"><p className="min-w-0 flex-1 break-words text-destructive">{!!entries?.length ? `${t('feeds.stale')} · ` : ''}{t('feeds.fetchFail')}{error}</p><Button size="sm" variant="outline" disabled={loading} onClick={() => void refresh()}>{t('feeds.retry')}</Button></div>}
      <ScrollArea className="min-h-0 flex-1 p-2">{loading && !entries?.length && !favoriteSource && <div role="status" className="flex items-center justify-center gap-2 py-14 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin"/>{t('feeds.loading')}</div>}
        {favoriteSource ? (favItems.length ? <ul>{favItems.map(item => <li className="group flex items-center" key={item.url}><button type="button" title={`${favoriteSourceName(item, sources, cache) || t("feeds.unknownSource")} · ${item.title}`} className={cn("flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-[13px]", selected?.url === item.url ? 'bg-accent' : 'hover:bg-accent/60')} onClick={() => selectEntry(item)} onDoubleClick={() => openArticle(item.url)}><span className="feed-favorite-source">{favoriteSourceName(item, sources, cache) || t("feeds.unknownSource")}</span><span aria-hidden="true" className="shrink-0 text-muted-foreground/40">·</span><span className="min-w-0 flex-1 truncate">{item.title}</span></button><Button size="icon" variant="ghost" aria-label={t('feeds.unfav')} onClick={() => removeFav(item.url)}><Star className="size-3.5 fill-current text-warning"/></Button></li>)}</ul> : <Empty>{t('feeds.favEmpty')}</Empty>) : entries?.length ? <ul>{entries.map((entry, index) => <li key={entry.id || entry.url}><button type="button" onClick={() => selectEntry(entry)} onDoubleClick={() => openArticle(entry.url)} title={entry.title} aria-pressed={selected?.url === entry.url} className={cn("flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-[13px] transition-colors", selected?.url === entry.url ? 'bg-accent' : 'hover:bg-accent/60')}><span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{index + 1}</span><span className="min-w-0 flex-1 truncate">{entry.title}</span>{entry.extra?.info && <span className="shrink-0 text-[11px] text-muted-foreground">{entry.extra.info}</span>}</button></li>)}</ul> : !loading && !error ? <Empty>{t('feeds.noResult')}</Empty> : null}
      </ScrollArea></main>
    {selected && (compact ? <Dialog open onOpenChange={open => { if (!open)
        selectEntry(null); }}><DialogContent className="flex h-[86vh] max-h-[900px] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"><DialogTitle className="sr-only">{selected.title}</DialogTitle><div className="flex min-h-0 flex-1 flex-col">{detail}</div></DialogContent></Dialog> : <div className="flex w-[48%] min-w-[380px] max-w-[680px] shrink-0 flex-col border-l">{detail}</div>)}
    <Dialog open={digestOpen} onOpenChange={open => { setDigestOpen(open); if (!open)
        digestVersion.current++; }}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle className="truncate pr-6 text-sm">{digestTitle}</DialogTitle></DialogHeader><ScrollArea className="max-h-[60vh]">{digestError && <p role="alert" className="text-sm text-destructive">{digestError}</p>}{!digestError && !digestText && digestRunning && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin"/>{t('feeds.aiReading')}</p>}{digestText && <div className="whitespace-pre-wrap text-sm leading-relaxed">{digestText}</div>}</ScrollArea></DialogContent></Dialog>
  </>;
}
function Empty({ children }: {
    children: React.ReactNode;
}) { return <div className="flex min-h-40 items-center justify-center px-4 text-center text-sm text-muted-foreground">{children}</div>; }
