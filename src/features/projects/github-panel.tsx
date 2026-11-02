/** GitHub 面板：token 门 → 三个列表（我的 / 已 star / 今日热榜）→ README 抽屉。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, ExternalLink, FolderGit2, GitFork, KeyRound, Link2, LoaderCircle, Pin, RefreshCw, Search, Star, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { cleanToken, repoFromTrending, repoMatches, sortPinned, upstreamGone } from "./github-core";
import { describeGithubError, fetchRepos, fetchTrending, fetchViewer, forgetToken, saveToken, setStar, tokenStatus } from "./github-api";
import { startForegroundInterval } from "@/lib/visibility";
import { useGithubCopy } from "./github-copy";
import { useGithub } from "./github-store";
import { useProjects } from "./store";
import { GithubReadme } from "./github-readme";
import { LocalRepos } from "./repos";
import { useLocalRepos } from "@/stores/local-repos";
import { GithubDownloadDialog, GithubLinkDialog } from "./github-dialogs";
import type { GithubRepo, GithubTokenSource, GithubViewer, TrendingRepo } from "./github-types";

type GithubTab = "mine" | "starred" | "trending" | "local";

export function GithubPanel({ onOpenProject }: { onOpenProject?: (projectId: string) => void }) {
  const c = useGithubCopy();
  const pins = useGithub(s => s.pins);
  const togglePin = useGithub(s => s.togglePin);
  const links = useGithub(s => s.links);
  const missing = useGithub(s => s.missing);
  const recordSync = useGithub(s => s.recordSync);
  const saveCache = useGithub(s => s.saveCache);
  const cacheReadme = useGithub(s => s.cacheReadme);
  const readmeCache = useGithub(s => s.cache.readmes);
  const dismissMissing = useGithub(s => s.dismissMissing);
  const localProjects = useProjects(s => s.projects);
  const [source, setSource] = useState<GithubTokenSource | null>(null);
  const [token, setToken] = useState("");
  const [viewer, setViewer] = useState<GithubViewer | null>(null);
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [starredRepos, setStarredRepos] = useState<GithubRepo[]>([]);
  const [starredIds, setStarredIds] = useState<Set<string>>(() => new Set());
  const [starredLoaded, setStarredLoaded] = useState(false);
  const [trending, setTrending] = useState<{ items: TrendingRepo[]; fallback: boolean }>({ items: [], fallback: false });
  const [tab, setTab] = useState<GithubTab>("mine");
  const localRepos = useLocalRepos((state) => state.repos);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(true);
  const [authFailed, setAuthFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GithubRepo | null>(null);
  const [downloading, setDownloading] = useState<GithubRepo | null>(null);
  const [linking, setLinking] = useState<GithubRepo | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [saving, setSaving] = useState(false);

  const fail = useCallback((e: unknown) => setError(describeGithubError(e, c)), [c]);

  /** 读 token → 身份 + 两个列表；任何一步 401 都退回连接卡片。quiet 用于后台轮询（不闪 spinner）。 */
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setBusy(true);
    setError(null);
    try {
      const status = await tokenStatus();
      setSource(status.source);
      if (status.source === "none") { setViewer(null); setRepos([]); setStarredRepos([]); setStarredIds(new Set()); return; }
      const value = await invoke<string>("github_token");
      setToken(value);
      const [me, mine, starred] = await Promise.all([fetchViewer(value), fetchRepos(value, "mine"), fetchRepos(value, "starred")]);
      setViewer(me); setRepos(mine.repos); setStarredRepos(starred.repos); setStarredIds(new Set(starred.repos.map(repo => repo.fullName))); setStarredLoaded(true);
      setAuthFailed(false);
      // 快照只用于「先出画面」，删除判定仍然只认 recordSync 的基线。
      if (useGithub.persist.hasHydrated()) saveCache({ viewer: me, starred: starred.repos });
      // 只有真的拉成功、而且拿到的是全集（没被页数上限截断）才记基线：
      // 网络失败或仓库超过 500 个时都不能做差集，否则会把在位仓库误判成「已不存在」。
      if (!mine.truncated && useGithub.persist.hasHydrated()) {
        const before = new Set(useGithub.getState().missing.map(entry => entry.repo.fullName));
        recordSync(me.login, mine.repos);
        const added = useGithub.getState().missing.filter(entry => !before.has(entry.repo.fullName)).map(entry => entry.repo.fullName);
        // 这一拍新标出来的仓库点名提醒一次，别只留一条藏在列表底部的灰行。
        if (added.length) toast.warning(`${c.goneToast}${added.join(c.listSeparator)}`);
      }
    } catch (e) {
      setError(describeGithubError(e, c));
      // 只有凭据问题才退回 token 态；断网/限流保留已经拉到的列表。
      if (/HTTP 401|GITHUB_TOKEN_MISSING/i.test(String(e))) { setAuthFailed(true); setViewer(null); }
    } finally {
      if (!quiet) setBusy(false);
    }
  }, [c, recordSync]);

  const loadTrending = useCallback(async () => {
    try {
      const result = await fetchTrending();
      setTrending(result);
      if (useGithub.persist.hasHydrated()) saveCache({ trending: result.items, trendingFallback: result.fallback });
    }
    catch (e) { setError(describeGithubError(e, c)); }
  }, [c]);

  useEffect(() => {
    const { cache, knownRepos } = useGithub.getState();
    const cached = Boolean(cache.viewer || knownRepos.length);
    void load(cached);
    void loadTrending();
  }, [load, loadTrending]);
  // 上游可能在应用开着的时候删仓库：前台每 5 分钟对齐一次，最小化时按 visibility 门控跳过。
  useEffect(() => startForegroundInterval(() => { void load(true); void loadTrending(); }, 5 * 60 * 1000), [load, loadTrending]);

  async function commitToken() {
    setSaving(true); setError(null);
    try {
      const value = cleanToken(tokenInput);
      // 先把 token 存好再验证：验证失败时用户只需改 token，不用重来。
      await saveToken(value);
      setTokenInput("");
      await load();
      setSource("vault");
    } catch (e) {
      setError(/GITHUB_INVALID_TOKEN/.test(String(e)) ? c.invalid : describeGithubError(e, c));
    } finally {
      setSaving(false);
    }
  }

  async function forget() {
    try { await forgetToken(); setSource("none"); setViewer(null); setRepos([]); setStarredRepos([]); setStarredIds(new Set()); setError(null); }
    catch (e) { fail(e); }
  }

  async function toggleStar(repo: GithubRepo) {
    const fullName = repo.fullName;
    const on = !starredIds.has(fullName);
    // 先改本地再发请求：star 是即时反馈操作，失败时回滚。
    setStarredIds(prev => { const next = new Set(prev); if (on) next.add(fullName); else next.delete(fullName); return next; });
    setStarredRepos(prev => on ? [repo, ...prev.filter(item => item.fullName !== fullName)] : prev.filter(item => item.fullName !== fullName));
    try { await setStar(token, fullName, on); }
    catch (e) {
      setStarredIds(prev => { const next = new Set(prev); if (on) next.delete(fullName); else next.add(fullName); return next; });
      setStarredRepos(prev => on ? prev.filter(item => item.fullName !== fullName) : [repo, ...prev]);
      fail(e);
    }
  }

  // 上次同步的快照：有它就先画出来，网络在后台补齐（stale-while-revalidate）。
  const cache = useGithub(s => s.cache);
  const cachedMine = useGithub(s => s.knownRepos);
  const displayMine = repos.length ? repos : cachedMine;
  const displayStarred = starredRepos.length ? starredRepos : cache.starred;
  const displayTrending = trending.items.length ? trending : { items: cache.trending, fallback: cache.trendingFallback };
  const displayViewer = viewer ?? cache.viewer;
  const displayIds = starredLoaded ? starredIds : new Set(cache.starred.map(entry => entry.fullName));

  const pinnedIds = useMemo(() => new Set(pins.map(pin => pin.fullName)), [pins]);
  const linkedProjects = useCallback((fullName: string) => {
    // 一个仓库可以挂多个本地项目：按关联顺序取回还在项目列表里的那些
    return links.filter(item => item.fullName === fullName)
      .map(item => localProjects.find(project => project.id === item.projectId))
      .filter((project): project is NonNullable<typeof project> => Boolean(project));
  }, [links, localProjects]);
  const gained = useMemo(() => new Map(displayTrending.items.map(item => [item.fullName, item.gained])), [displayTrending]);
  const rows: GithubRepo[] = useMemo(() => {
    if (tab === "trending") return displayTrending.items.map(repoFromTrending).filter(repo => repoMatches(repo, query));
    // 已 star 的仓库可能是别人的，不能用「我的仓库」过滤，直接列 star 快照。
    const base = (tab === "starred" ? displayStarred : displayMine).filter(repo => repoMatches(repo, query));
    return sortPinned(base, pinnedIds);
  }, [tab, displayMine, displayStarred, displayTrending, query, pinnedIds]);

  const needsToken = source === "none" || authFailed;
  const count = (kind: GithubTab) => kind === "mine" ? displayMine.length : kind === "starred" ? displayStarred.length : kind === "local" ? localRepos.length : displayTrending.items.length;
  // 页头：标题 +（未连接时）就地 token 输入；未连接不画工作区框——空卡片比留白更像坏掉。
  const header = <header className="mb-4 flex shrink-0 flex-wrap items-center gap-3">
    <FolderGit2 className="size-5 shrink-0 text-primary" />
    <h1 className="truncate text-xl font-semibold tracking-tight">{c.pageTitle}</h1>
    {needsToken && <div className="relative ml-auto flex items-center gap-2">
      <KeyRound aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input id="github-token" autoFocus type="password" autoComplete="off" spellCheck={false} value={tokenInput}
        onChange={event => setTokenInput(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter") void commitToken(); }}
        aria-label={c.token} placeholder={c.token}
        className="h-8 w-[240px] pl-8 font-mono text-xs" />
      <Button size="sm" disabled={saving || !tokenInput.trim()} onClick={() => void commitToken()}>{saving ? c.saving : c.save}</Button>
      <Button variant="ghost" size="icon-sm" title={c.createToken} aria-label={c.createToken} onClick={() => void openUrl("https://github.com/settings/tokens/new?scopes=public_repo&description=NimbusDesk").catch(() => {})}><ExternalLink /></Button>
    </div>}
  </header>;

  // token 状态还没回来：只画标题和一句加载，别先把页签、搜索、空列表画出来再塌掉。
  if (source === null && !authFailed) return <div className="flex h-full min-h-0 flex-col p-4 lg:p-6">
    {header}
    <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
      <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />{c.loading}
    </div>
  </div>;

  if (needsToken) return <div className="flex h-full min-h-0 flex-col p-4 lg:p-6">
    {header}
    {error && <p role="alert" className="flex flex-wrap items-center gap-2 text-[11px] text-destructive">{error}
      {source === "vault" && <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => void forget()}>{c.forget}</button>}
    </p>}
    <div className="min-h-0 flex-1" />
  </div>;

  return <div className="flex h-full min-h-0 flex-col p-4 lg:p-6">
    {header}
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
      {(["mine", "starred", "trending", "local"] as const).map(kind => <button key={kind} type="button" aria-pressed={tab === kind} onClick={() => setTab(kind)}
        className={cn("rounded-md px-2 py-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring", tab === kind ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
        {c[kind]}<span className="ml-1.5 text-[11px] tabular-nums opacity-70">{count(kind)}</span>
      </button>)}
      <div className="ml-auto flex min-w-0 items-center gap-2">
        {tab !== "local" && displayViewer && <span className="hidden max-w-[180px] truncate text-[11px] text-muted-foreground md:inline" title={`${displayMine.length} ${c.count}`}>@{displayViewer.login} · {displayMine.length}</span>}
        {tab !== "local" && <div className="relative min-w-[150px] flex-1 md:w-[240px] md:flex-none"><Search className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-muted-foreground" /><Input value={query} onChange={e => setQuery(e.target.value)} className="h-7 pr-7 pl-8 text-xs" placeholder={c.search} aria-label={c.search} />{query && <Button className="absolute top-0 right-0.5 h-7" variant="ghost" size="icon-xs" title={c.clearSearch} aria-label={c.clearSearch} onClick={() => setQuery("")}><X /></Button>}</div>}
        {tab !== "local" && <Button variant="ghost" size="icon-sm" title={c.refreshing} aria-label={c.refreshing} disabled={busy} onClick={() => { if (tab === "trending") void loadTrending(); else void load(); }}><RefreshCw className={busy ? "animate-spin motion-reduce:animate-none" : undefined} /></Button>}
      </div>
    </div>
    {tab === "trending" && displayTrending.fallback && <p className="shrink-0 border-b border-border bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">{c.trendingFallback}</p>}
    {error && <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5"><p role="alert" className="text-[11px] text-destructive">{error}</p><Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setError(null)}>{c.close}</Button></div>}
    {tab === "mine" && missing.length > 0 && <div data-github-missing-banner="" className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">
      <span>{missing.length} {c.deletedBanner}</span>
      <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => missing.forEach(entry => dismissMissing(entry.repo.fullName))}>{c.removeMissingAll}</button>
    </div>}
    {tab === "local" ? <LocalRepos /> : <div className="min-h-0 flex-1 overflow-y-auto" role="list">
      {tab === "mine" && missing.map(entry => <div key={`gone-${entry.repo.fullName}`} data-github-missing={entry.repo.fullName} role="listitem" className="flex min-w-0 items-center gap-2 border-b border-border/60 bg-muted/20 px-3 py-1 last:border-0">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5">
          <span className="flex min-w-0 items-center gap-1.5"><span className="truncate text-sm text-muted-foreground line-through">{entry.repo.fullName}</span><span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{c.gone}</span></span>
          <span className="truncate text-[11px] text-muted-foreground">{c.goneHint}</span>
        </div>
        <Button variant="ghost" size="icon-xs" title={c.open} aria-label={`${c.open} · ${entry.repo.fullName}`} onClick={() => void openUrl(entry.repo.htmlUrl).catch(() => {})}><ExternalLink /></Button>
        <Button variant="ghost" size="icon-xs" title={c.removeMissing} aria-label={`${c.removeMissing} · ${entry.repo.fullName}`} onClick={() => dismissMissing(entry.repo.fullName)}><X /></Button>
      </div>)}
      {busy && !rows.length ? <p className="flex items-center justify-center gap-2 p-8 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />{c.loading}</p>
        : !rows.length && !(tab === "mine" && missing.length && !query) ? <div className="flex min-h-[160px] flex-col items-center justify-center gap-3 p-8 text-center text-xs text-muted-foreground">
          <p>{query ? c.noMatches : tab === "mine" ? c.emptyMine : tab === "starred" ? c.emptyStarred : c.emptyTrending}</p>
          {!query && tab === "mine" && <Button size="sm" variant="outline" onClick={() => void openUrl("https://github.com/new").catch(() => {})}>{c.newRepo}</Button>}
          {!query && tab === "trending" && <Button size="sm" variant="outline" onClick={() => void loadTrending()}>{c.refreshing}</Button>}
        </div>
        : rows.map(repo => {
          const starred = displayIds.has(repo.fullName);
          const pinned = pinnedIds.has(repo.fullName);
          const linked = linkedProjects(repo.fullName);
          const trendingRepo = tab === "trending";
          return <div key={`${tab}-${repo.fullName}`} role="listitem" data-github-repo={repo.fullName} className="group flex min-h-[58px] min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1 last:border-0 hover:bg-muted/40">
            <button type="button" aria-pressed={selected?.fullName === repo.fullName}
              className={cn("flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring", selected?.fullName === repo.fullName && "bg-accent/60")}
              title={repo.fullName} onClick={() => setSelected(repo)}>
              <span className="flex min-w-0 max-w-full items-center gap-1.5">
                {pinned && <Pin className={cn("size-3 shrink-0 fill-current", "text-primary")} aria-label={c.pin} />}
                <span className="truncate text-sm font-medium">{repo.fullName}</span>
                {repo.fork && <span data-github-fork="" className="flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground" title={repo.parentFullName ? `${c.forkFrom} ${repo.parentFullName}` : c.upstreamGone}><GitFork className="size-2.5" />{c.fork}</span>}
                {upstreamGone(repo) && <span data-github-parent-missing="" className="shrink-0 rounded bg-destructive/12 px-1 py-0.5 text-[10px] text-destructive" title={c.upstreamGoneHint}>{c.upstreamGone}</span>}
                {repo.archived && <span data-github-archived="" className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{c.archived}</span>}
                {linked.length > 0 && <>
                  <span data-github-linked="" className="max-w-[140px] shrink-0 truncate rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground" title={`${c.linkedTo} ${linked.map(project => project.name).join(c.listSeparator)}`}>{linked[0].name}</span>
                  {linked.length > 1 && <span data-github-linked-more="" className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground" title={`${c.linkedTo} ${linked.map(project => project.name).join(c.listSeparator)}`}>+{linked.length - 1}</span>}
                </>}
              </span>
              <span className="flex w-full min-w-0 items-center gap-2 text-[11px] text-muted-foreground"><span className="truncate">{repo.description || repo.language || ""}</span>{repo.language && repo.description && <span className="shrink-0">{repo.language}</span>}</span>
            </button>
            {trendingRepo && (gained.get(repo.fullName) ?? 0) > 0 && <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums" title={c.gained}>+{(gained.get(repo.fullName) ?? 0).toLocaleString()} {c.gained}</span>}
            <span className="flex w-16 shrink-0 items-center justify-end gap-1 text-[11px] text-muted-foreground tabular-nums" title={`${repo.stars} ${c.stars}`}><Star className="size-3" />{repo.stars.toLocaleString()}</span>
            <div className="flex shrink-0 items-center gap-0.5">
              {!trendingRepo && <>
                <button type="button" aria-pressed={pinned} title={pinned ? c.unpin : c.pin} aria-label={`${pinned ? c.unpin : c.pin} · ${repo.fullName}`} onClick={() => togglePin(repo.fullName)}
                  className={cn("rounded p-1 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring", pinned ? "text-primary" : "text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}><Pin className={cn("size-3.5", pinned && "fill-current")} /></button>
                <button type="button" data-github-download="" title={c.download} aria-label={`${c.download} · ${repo.fullName}`} onClick={() => setDownloading(repo)}
                  className="rounded p-1 text-muted-foreground opacity-0 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100"><Download className="size-3.5" /></button>
                <button type="button" data-github-link="" title={c.link} aria-label={`${c.link} · ${repo.fullName}`} onClick={() => setLinking(repo)}
                  className="rounded p-1 text-muted-foreground opacity-0 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100"><Link2 className="size-3.5" /></button>
              </>}
              <button type="button" disabled={trendingRepo} aria-pressed={starred} title={starred ? c.unstar : c.star} aria-label={`${starred ? c.unstar : c.star} · ${repo.fullName}`} onClick={() => void toggleStar(repo)} className={cn("rounded p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40", starred ? "text-amber-500" : "text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}><Star className={cn("size-3.5", starred && "fill-current")} /></button>
              <Button variant="ghost" size="icon-xs" title={c.open} aria-label={`${c.open} · ${repo.fullName}`} onClick={() => void openUrl(repo.htmlUrl).catch(() => {})}><ExternalLink /></Button>
            </div>
          </div>;
        })}
    </div>}
      {selected && <GithubReadme key={selected.fullName} repo={selected} token={token} copy={c} cached={readmeCache[selected.fullName]?.markdown} onLoaded={markdown => { if (useGithub.persist.hasHydrated()) cacheReadme(selected.fullName, markdown); }} starred={displayIds.has(selected.fullName)} onStarToggle={() => void toggleStar(selected)} onClose={() => { const closing = selected.fullName; setSelected(null); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-github-repo="${CSS.escape(closing)}"] button`)?.focus()); }} />}
    </div>
    {downloading && <GithubDownloadDialog repo={downloading} copy={c} onClose={() => setDownloading(null)} />}
    {linking && <GithubLinkDialog repo={linking} copy={c} onClose={() => setLinking(null)} onOpenProject={onOpenProject} />}
  </div>;
}
