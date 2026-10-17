import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, ArrowDown, Plus, Trash2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useFeedNetwork } from '@/stores/feed-network';
import { loadGithubRoute } from '@/sources/hot/github';
import { DEFAULT_GITHUB_ROUTES, GITHUB_DIRECT, fetchGithubRoutes, normalizeGithubRoutes, type GithubRoute } from './github-network';
export function FeedNetworkSettings() {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(() => useFeedNetwork.getState().routes.map(route => ({ ...route })));
    const [busy, setBusy] = useState<string | null>(null);
    const [results, setResults] = useState<Record<string, {
        signature: string;
        message: string;
        ok: boolean;
    }>>({});
    const [error, setError] = useState('');
    const lastRoute = useFeedNetwork(state => state.lastRoute);
    const update = (id: string, patch: Partial<GithubRoute>) => { setDraft(routes => routes.map(route => route.id === id ? { ...route, ...patch } : route)); setError(''); };
    function move(index: number, delta: number) {
        setDraft(routes => { const next = [...routes]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; return next; });
    }
    async function testRoute(route: GithubRoute) {
        if (busy)
            return;
        if (normalizeGithubRoutes([route]).length !== 1) {
            setError(t('feeds.invalidRoute'));
            return;
        }
        setBusy(route.id);
        const signature = JSON.stringify(route);
        try {
            const result = await fetchGithubRoutes([{ ...route, enabled: true }], item => loadGithubRoute(item));
            setResults(values => ({ ...values, [route.id]: { signature, message: t('feeds.testPassed', { count: result.entries.length }), ok: true } }));
        }
        catch (cause) {
            setResults(values => ({ ...values, [route.id]: { signature, message: String(cause instanceof Error ? cause.message : cause), ok: false } }));
        }
        finally {
            setBusy(null);
        }
    }
    function save() {
        const normalized = normalizeGithubRoutes(draft);
        if (normalized.length !== draft.length || new Set(normalized.map(route => route.url)).size !== normalized.length) {
            setError(t('feeds.invalidRoute'));
            return;
        }
        useFeedNetwork.getState().setRoutes(normalized);
        toast.success(t('feeds.networkSaved'));
    }
    return <section className="space-y-5" aria-label={t('feeds.networkTitle')}>
    <header><h2 className="text-base font-semibold">{t('feeds.networkTitle')}</h2><p className="mt-2 text-xs leading-6 text-muted-foreground">{t('feeds.networkHint')}</p></header>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4"><div><p className="text-sm font-medium">{t('feeds.directFirst')}</p><p className="mt-1 text-xs text-muted-foreground">github.com · {t('feeds.routeTimeout')}</p></div><Button size="sm" variant="outline" disabled={!!busy} onClick={() => void testRoute(GITHUB_DIRECT)}>{busy === 'direct' ? <Loader2 className="size-3.5 animate-spin"/> : null}{t('feeds.testRoute')}</Button></div>
    {results.direct && <p role="status" className={results.direct.ok ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}>{results.direct.message}</p>}
    <p className="text-xs leading-6 text-muted-foreground">{t('feeds.backupHint')}</p>
    <ol className="space-y-4">{draft.map((route, index) => {
            const result = results[route.id];
            return <li key={route.id} className="space-y-3 border-b pb-4">
        <div className="flex flex-wrap items-center gap-2"><span className="mr-1 text-xs tabular-nums text-muted-foreground">{index + 1}</span><Label className="flex cursor-pointer items-center gap-2 text-xs"><input type="checkbox" checked={route.enabled} onChange={event => update(route.id, { enabled: event.target.checked })}/>{t('feeds.enabled')}</Label><div className="ml-auto flex gap-1"><Button size="icon" variant="ghost" aria-label={t('feeds.moveUp')} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp className="size-3.5"/></Button><Button size="icon" variant="ghost" aria-label={t('feeds.moveDown')} disabled={index === draft.length - 1} onClick={() => move(index, 1)}><ArrowDown className="size-3.5"/></Button><Button size="icon" variant="ghost" aria-label={t('feeds.removeRoute')} onClick={() => setDraft(routes => routes.filter(item => item.id !== route.id))}><Trash2 className="size-3.5"/></Button></div></div>
        <div className="flex gap-2"><Input aria-label={t('feeds.routeName')} className="min-w-0 flex-1" value={route.name} onChange={event => update(route.id, { name: event.target.value })}/><select aria-label={t('feeds.routeFormat')} className="rounded-md border bg-background px-2 text-xs" value={route.format} onChange={event => update(route.id, { format: event.target.value as GithubRoute['format'] })}><option value="rss">RSS / Atom</option><option value="html">HTML</option></select></div>
        <div className="flex items-center gap-2"><Input aria-label={t('feeds.routeUrl')} className="min-w-0 flex-1 text-xs" value={route.url} placeholder="https://example.com/trending.xml" onChange={event => update(route.id, { url: event.target.value })}/><Button variant="outline" size="sm" disabled={!!busy} onClick={() => void testRoute(route)}>{busy === route.id ? <Loader2 className="size-3.5 animate-spin"/> : null}{t('feeds.testRoute')}</Button></div>
        {result?.signature === JSON.stringify(route) && <p role="status" className={result.ok ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}>{result.message}</p>}
      </li>;
        })}</ol>
    {lastRoute && <p className="text-xs text-muted-foreground">{t('feeds.currentRoute', { name: lastRoute.name })}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <footer className="flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" disabled={draft.length >= 6} onClick={() => setDraft(routes => [...routes, { id: crypto.randomUUID(), name: '', url: '', format: 'rss', enabled: true }])}><Plus className="size-3.5"/>{t('feeds.addRoute')}</Button><Button variant="ghost" size="sm" onClick={() => { setDraft(DEFAULT_GITHUB_ROUTES.map(route => ({ ...route }))); setError(''); }}>{t('feeds.resetRoutes')}</Button><Button className="ml-auto" size="sm" onClick={save}>{t('feeds.saveNetwork')}</Button></footer>
  </section>;
}
