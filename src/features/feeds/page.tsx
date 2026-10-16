import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, Star, RefreshCw, Plus, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useFeeds, FAVORITES_ID } from "@/stores/feeds";
import { useFavorites } from "@/stores/favorites";
import { useCustomFeeds } from "@/stores/custom-feeds";
import { mergedSources } from "@/sources/custom";
import { summarizeList, summarizeUrl } from "@/digest/summarize";
import { openExternal } from "@/lib/open";
import { cn } from "@/lib/utils";
import { AddFeedDialog } from "./add-dialog";
import { AiSearchView } from "./ai-search";

const GROUP_KEYS: Record<string, string> = {
  技术: "feeds.groupTech",
  资讯: "feeds.groupMedia",
  社区: "feeds.groupCommunity",
  订阅: "feeds.groupSub",
};

/** 资讯页：信息流 + AI 搜索 双页签 */
export function FeedsPage() {
  const { t } = useTranslation();
  const activeId = useFeeds((s) => s.activeId);
  const selectSource = useFeeds((s) => s.selectSource);
  const refresh = useFeeds((s) => s.refresh);
  const favCount = useFavorites((s) => s.items.length);
  const removeCustom = useCustomFeeds((s) => s.remove);
  const [addOpen, setAddOpen] = useState(false);

  const sources = mergedSources();
  const groups: string[] = [];
  for (const s of sources) if (!groups.includes(s.group)) groups.push(s.group);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Tabs defaultValue="flow" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex items-center gap-2 border-b px-4 py-2.5">
          <TabsList>
            <TabsTrigger value="flow">{t("feeds.tabFlow")}</TabsTrigger>
            <TabsTrigger value="ai">{t("feeds.tabAi")}</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="flow" className="mt-0 min-h-0 flex-1">
          <div className="flex h-full">
            {/* 源侧栏 */}
            <aside className="hidden w-52 shrink-0 flex-col border-r md:flex">
              <ScrollArea className="flex-1 px-2 py-2">
                <button
                  onClick={() => selectSource(FAVORITES_ID)}
                  className={cn(
                    "mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                    activeId === FAVORITES_ID ? "bg-accent font-medium" : "hover:bg-accent/60",
                  )}
                >
                  <Star className="size-4 text-warning" />
                  {t("feeds.favorites")}
                  {favCount > 0 && (
                    <Badge variant="secondary" className="ml-auto px-1.5">
                      {favCount}
                    </Badge>
                  )}
                </button>
                {groups.map((g) => (
                  <div key={g} className="mt-2">
                    <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                      {t(GROUP_KEYS[g] ?? "feeds.groupSub")}
                    </div>
                    {sources
                      .filter((s) => s.group === g)
                      .map((s) => {
                        const isCustom = s.id.startsWith("rss:");
                        return (
                          <div key={s.id} className="group relative">
                            <button
                              onClick={() => selectSource(s.id)}
                              className={cn(
                                "w-full truncate rounded-md px-2.5 py-1.5 pr-7 text-left text-sm transition-colors",
                                activeId === s.id ? "bg-accent font-medium" : "hover:bg-accent/60",
                              )}
                            >
                              {s.name}
                            </button>
                            {isCustom && (
                              <button
                                title={t("feeds.removeSource")}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (confirm(`${t("feeds.removeSource")}: ${s.name}?`)) {
                                    removeCustom(s.id);
                                  }
                                }}
                                className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-destructive group-hover:block"
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        );
                      })}
                  </div>
                ))}
              </ScrollArea>
              <div className="flex justify-end border-t p-2">
                <Button variant="ghost" size="icon" title={t("feeds.addSource")} onClick={() => setAddOpen(true)}>
                  <Plus className="size-4" />
                </Button>
              </div>
            </aside>

            <FlowView />
          </div>
        </TabsContent>

        <TabsContent value="ai" className="mt-0 min-h-0 flex-1">
          <AiSearchView />
        </TabsContent>
      </Tabs>

      <AddFeedDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

/** 信息流三栏（列表 + 详情） */
function FlowView() {
  const { t } = useTranslation();
  const activeId = useFeeds((s) => s.activeId);
  const entries = useFeeds((s) => s.entriesBySource[s.activeId]);
  const loading = useFeeds((s) => s.loading[s.activeId]);
  const error = useFeeds((s) => s.error[s.activeId]);
  const selected = useFeeds((s) => s.selected);
  const selectEntry = useFeeds((s) => s.selectEntry);
  const refresh = useFeeds((s) => s.refresh);
  const favItems = useFavorites((s) => s.items);
  const toggleFav = useFavorites((s) => s.toggle);
  const removeFav = useFavorites((s) => s.remove);
  const [digestOpen, setDigestOpen] = useState(false);
  const [digestTitle, setDigestTitle] = useState("");
  const [digestText, setDigestText] = useState("");
  const [digestRunning, setDigestRunning] = useState(false);
  const [digestError, setDigestError] = useState<string | null>(null);

  const isFav = selected ? favItems.some((i) => i.url === selected.url) : false;
  const name = mergedSources().find((s) => s.id === activeId)?.name ?? activeId;

  const openDigest = (ti: string, run: (onDelta: (d: string) => void) => Promise<string>) => {
    setDigestTitle(ti);
    setDigestText("");
    setDigestError(null);
    setDigestOpen(true);
    setDigestRunning(true);
    run((d) => setDigestText((prev) => prev + d))
      .catch((e) => setDigestError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDigestRunning(false));
  };

  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b px-4 py-2.5">
          <h2 className="text-sm font-semibold">{name}</h2>
          {entries?.length ? (
            <Badge variant="secondary" className="px-1.5">{entries.length}</Badge>
          ) : null}
          <span className="ml-auto hidden text-[11px] text-muted-foreground lg:inline">
            {t("feeds.clickHint")}
          </span>
          {activeId !== FAVORITES_ID && (
            <Button variant="ghost" size="icon" title={t("feeds.refresh")} onClick={() => void refresh()}>
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            </Button>
          )}
          {entries?.length ? (
            <Button
              variant="ghost"
              size="icon"
              title={t("feeds.aiBrief")}
              onClick={() =>
                openDigest(`${name} · AI`, (onDelta) => summarizeList(name, entries, onDelta))
              }
            >
              <Sparkles className="size-4" />
            </Button>
          ) : null}
        </header>

        <ScrollArea className="min-h-0 flex-1 p-2">
          {error && !entries?.length ? (
            <div className="p-4 text-sm text-destructive">
              {t("feeds.fetchFail")}
              {error}
              <button onClick={() => void refresh()} className="ml-2 underline underline-offset-2">
                {t("feeds.retry")}
              </button>
            </div>
          ) : null}
          {!error && loading && !entries?.length ? (
            <div className="space-y-1.5 p-1">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-9 animate-pulse rounded-md bg-muted" />
              ))}
            </div>
          ) : null}
          {activeId === FAVORITES_ID ? (
            favItems.length ? (
              <ul className="space-y-0.5">
                {favItems.map((f) => (
                  <li
                    key={f.url}
                    onClick={() => selectEntry(f)}
                    onDoubleClick={() => void openExternal(f.url)}
                    title={f.extra?.hover}
                    className={cn(
                      "group flex cursor-pointer items-baseline gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                      selected?.url === f.url ? "bg-accent" : "hover:bg-accent/60",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{f.title}</span>
                    {f.sourceName && (
                      <span className="shrink-0 text-[11px] text-muted-foreground">{f.sourceName}</span>
                    )}
                    <button
                      title={t("feeds.unfav")}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeFav(f.url);
                      }}
                      className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:block"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>{t("feeds.favEmpty")}</Empty>
            )
          ) : entries?.length ? (
            <ul className="space-y-0.5">
              {entries.map((e, i) => (
                <li
                  key={e.id}
                  onClick={() => selectEntry(e)}
                  onDoubleClick={() => void openExternal(e.url)}
                  title={e.extra?.hover}
                  className={cn(
                    "flex cursor-pointer items-baseline gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                    selected?.url === e.url ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{e.title}</span>
                  {e.extra?.info && (
                    <Badge variant="secondary" className="shrink-0 px-1.5 text-[11px]">
                      {e.extra.info}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          ) : !loading && !error ? (
            <Empty>{t("feeds.noResult")}</Empty>
          ) : null}
        </ScrollArea>
      </main>

      {/* 详情面板 */}
      {selected ? (
        <section className="hidden w-[360px] shrink-0 flex-col border-l xl:flex">
          <header className="border-b px-4 py-2.5 text-[11px] text-muted-foreground">
            {t("feeds.detail")}
          </header>
          <ScrollArea className="min-h-0 flex-1 p-4">
            <h3 className="text-base font-semibold leading-snug">{selected.title}</h3>
            {selected.extra?.info && (
              <Badge variant="secondary" className="mt-2">{selected.extra.info}</Badge>
            )}
            {selected.extra?.hover && (
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {selected.extra.hover}
              </p>
            )}
            {selected.pubDate ? (
              <p className="mt-3 text-[11px] text-muted-foreground">
                {new Date(selected.pubDate).toLocaleString()}
              </p>
            ) : null}
          </ScrollArea>
          <footer className="flex gap-2 border-t p-3">
            <Button className="flex-1" onClick={() => void openExternal(selected.url)}>
              <ExternalLink className="size-4" />
              {t("feeds.open")}
            </Button>
            <Button
              variant="outline"
              onClick={() => toggleFav(selected, name)}
              className={cn(isFav && "border-warning/60 text-warning")}
            >
              <Star className={cn("size-4", isFav && "fill-current")} />
              {isFav ? t("feeds.saved") : t("feeds.save")}
            </Button>
            <Button
              variant="outline"
              title={t("feeds.summarize")}
              onClick={() =>
                openDigest(selected.title.slice(0, 24), (onDelta) =>
                  summarizeUrl(selected.url, onDelta),
                )
              }
            >
              <Sparkles className="size-4" />
            </Button>
          </footer>
        </section>
      ) : null}

      {/* AI 摘要弹框 */}
      <Dialog open={digestOpen} onOpenChange={setDigestOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="truncate pr-6 text-sm">{digestTitle}</DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            {digestError ? <div className="text-sm text-destructive">{digestError}</div> : null}
            {!digestError && !digestText && digestRunning ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t("feeds.aiReading")}
              </div>
            ) : null}
            {digestText ? (
              <div className="whitespace-pre-wrap text-sm leading-relaxed">{digestText}</div>
            ) : null}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
