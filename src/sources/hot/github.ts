/**
 * GitHub Trending —— HTML 抓取。
 * 选择器按 2026-10 实测 DOM 校准：article 内 repo 链接由其 stargazers 链接派生
 * （href = "/owner/repo/stargazers" → 去 "/stargazers"），比 h2>a 更抗改版。
 */
import type { SourceAdapter, SourceEntry } from "../types";
import { httpText } from "../http";

export const github: SourceAdapter = {
  id: "github-trending",
  name: "GitHub Trending",
  group: "技术",
  homepage: "https://github.com/trending",
  async fetch() {
    const html = await httpText("https://github.com/trending?spoken_language_code=");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const articles = doc.querySelectorAll("article.Box-row");
    const entries: SourceEntry[] = [];

    articles.forEach((el) => {
      const starsLink = el.querySelector('a[href$="/stargazers"]');
      if (!starsLink) return;
      const repoPath = (starsLink.getAttribute("href") ?? "").replace(/\/stargazers$/, "");
      const repoLink = el.querySelector(`a[href="${repoPath}"]`);
      const title = (repoLink?.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!repoPath || !title) return;
      const star = starsLink.textContent?.replace(/\s+/g, "").trim() ?? "";
      const desc =
        el.querySelector("p")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      entries.push({
        id: repoPath,
        title,
        url: `https://github.com${repoPath}`,
        extra: { info: star ? `✰ ${star}` : undefined, hover: desc },
      });
    });
    return entries;
  },
};
