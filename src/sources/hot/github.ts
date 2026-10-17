/**
 * GitHub Trending —— HTML 抓取。
 * 选择器按 2026-10 实测 DOM 校准：article 内 repo 链接由其 stargazers 链接派生
 * （href = "/owner/repo/stargazers" → 去 "/stargazers"），比 h2>a 更抗改版。
 */
import type { SourceAdapter, SourceEntry } from "../types";
import { httpText } from "../http";
import { fetchRssEntries } from '../rss';
import { useFeedNetwork } from '@/stores/feed-network';
import { fetchGithubRoutes, GITHUB_DIRECT, type GithubRoute } from '@/features/feeds/github-network';
export const github: SourceAdapter = {
    id: "github-trending",
    name: "GitHub Trending",
    group: "技术",
    homepage: "https://github.com/trending",
    async fetch() {
        if (!useFeedNetwork.persist.hasHydrated())
            await new Promise<void>(resolve => {
                const off = useFeedNetwork.persist.onFinishHydration(() => { off(); resolve(); });
                if (useFeedNetwork.persist.hasHydrated()) {
                    off();
                    resolve();
                }
            });
        const result = await fetchGithubRoutes([GITHUB_DIRECT, ...useFeedNetwork.getState().routes], route => loadGithubRoute(route));
        useFeedNetwork.getState().setLastRoute(result.route);
        return result.entries;
    },
};
export async function loadGithubRoute(route: GithubRoute, parent?: AbortSignal): Promise<SourceEntry[]> {
    const signal = AbortSignal.any([AbortSignal.timeout(6000), ...(parent ? [parent] : [])]);
    if (route.format === 'rss')
        return fetchRssEntries(route.url, 50, signal);
    const html = await httpText(route.url, { signal });
    const doc = new DOMParser().parseFromString(html, "text/html");
    const articles = doc.querySelectorAll("article.Box-row");
    const entries: SourceEntry[] = [];
    articles.forEach((el) => {
        const starsLink = el.querySelector('a[href$="/stargazers"]');
        if (!starsLink)
            return;
        const repoPath = (starsLink.getAttribute("href") ?? "").replace(/\/stargazers$/, "");
        const repoLink = el.querySelector(`a[href="${repoPath}"]`);
        const title = (repoLink?.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!repoPath || !title)
            return;
        const star = starsLink.textContent?.replace(/\s+/g, "").trim() ?? "";
        const desc = el.querySelector("p")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        entries.push({
            id: repoPath,
            title,
            url: `https://github.com${repoPath}`,
            extra: { info: star ? `✰ ${star}` : undefined, hover: desc },
        });
    });
    return entries;
}
