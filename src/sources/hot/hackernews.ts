/** Hacker News —— HTML 抓取 + RSS 兜底（移植自 newsnow） */
import type { SourceAdapter, SourceEntry } from "../types";
import { httpText } from "../http";
import { fetchRssEntries } from "../rss";

const baseURL = "https://news.ycombinator.com";

async function fetchDirect(): Promise<SourceEntry[]> {
  const html = await httpText(baseURL);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows = doc.querySelectorAll(".athing");
  const entries: SourceEntry[] = [];
  rows.forEach((el) => {
    const a = el.querySelector(".titleline a");
    const id = el.getAttribute("id");
    if (!a || !id) return;
    const title = (a.textContent ?? "").trim();
    const href = a.getAttribute("href") ?? "";
    const score = doc.querySelector(`#score_${id}`)?.textContent?.trim() ?? "";
    if (title && href) {
      entries.push({
        id,
        title,
        url: href.startsWith("http") ? href : `${baseURL}/${href}`,
        extra: { info: score || undefined, hover: title },
      });
    }
  });
  return entries;
}

async function fetchViaRss(): Promise<SourceEntry[]> {
  const items = await fetchRssEntries("https://hnrss.org/frontpage?count=30");
  return items.map((it) => {
    const desc = it.extra?.hover ?? "";
    // hnrss 描述里带 "Points: N" 与评论链接
    const points = /Points: (\d+)/.exec(desc)?.[1];
    return {
      ...it,
      extra: { ...it.extra, info: points ? `${points} points` : it.extra?.info },
    };
  });
}

export const hackernews: SourceAdapter = {
  id: "hackernews",
  name: "Hacker News",
  group: "技术",
  homepage: baseURL,
  async fetch() {
    const direct = await fetchDirect().catch(() => [] as SourceEntry[]);
    if (direct.length) return direct;
    return fetchViaRss();
  },
};
