import type { SourceEntry } from '@/sources/types';
export interface GithubRoute {
    id: string;
    name: string;
    url: string;
    format: 'rss' | 'html';
    enabled: boolean;
}
export const GITHUB_DIRECT: GithubRoute = { id: 'direct', name: 'GitHub', url: 'https://github.com/trending?spoken_language_code=', format: 'html', enabled: true };
export const DEFAULT_GITHUB_ROUTES: GithubRoute[] = [
    { id: 'pages', name: 'GitHub Pages RSS', url: 'https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml', format: 'rss', enabled: true },
    { id: 'jsdelivr', name: 'jsDelivr RSS', url: 'https://cdn.jsdelivr.net/gh/mshibanami/GitHubTrendingRSS@gh-pages/daily/all.xml', format: 'rss', enabled: true },
];
export function normalizeGithubRoutes(input: unknown): GithubRoute[] {
    if (!Array.isArray(input))
        return [];
    const ids = new Set<string>();
    return input.flatMap((value): GithubRoute[] => {
        if (!value || typeof value !== 'object')
            return [];
        try {
            const url = new URL(value.url);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.includes('...') || !['rss', 'html'].includes(value.format) || typeof value.id !== 'string' || !value.id || ids.has(value.id))
                return [];
            ids.add(value.id);
            return [{ id: value.id, name: String(value.name || url.hostname).slice(0, 80), url: url.href, format: value.format, enabled: value.enabled !== false }];
        }
        catch {
            return [];
        }
    }).slice(0, 6);
}
export function githubEntries(entries: SourceEntry[]): SourceEntry[] {
    const seen = new Set<string>();
    return entries.flatMap(entry => {
        try {
            const url = new URL(entry.url);
            const parts = url.pathname.split('/').filter(Boolean);
            if (url.hostname !== 'github.com' || url.username || url.password || parts.length !== 2 || !entry.title?.trim() || !['http:', 'https:'].includes(url.protocol))
                return [];
            const canonical = `https://github.com/${parts.join('/')}`;
            if (seen.has(canonical))
                return [];
            seen.add(canonical);
            return [{ ...entry, id: url.pathname, url: canonical }];
        }
        catch {
            return [];
        }
    });
}
export async function fetchGithubRoutes(routes: GithubRoute[], load: (route: GithubRoute) => Promise<SourceEntry[]>, signal?: AbortSignal) {
    const failed: string[] = [];
    for (const route of routes) {
        signal?.throwIfAborted();
        if (route.enabled === false)
            continue;
        try {
            const entries = githubEntries(await load(route));
            signal?.throwIfAborted();
            if (!entries.length)
                throw new Error('No valid GitHub repositories');
            return { entries, route };
        }
        catch (error) {
            signal?.throwIfAborted();
            failed.push(`${route.name}: ${error instanceof Error ? error.message : 'Unavailable'}`);
        }
    }
    throw new Error(failed.join(' · ') || 'No GitHub routes enabled');
}
