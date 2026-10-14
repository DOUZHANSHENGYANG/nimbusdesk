/** V2EX 今日热门主题 —— 多节点 JSON feed 聚合（移植自 newsnow） */
import type { SourceAdapter, SourceEntry } from "../types";
import { httpJson } from "../http";

interface Res {
  items: {
    url: string;
    date_modified?: string;
    date_published?: string;
    title: string;
    id: string;
  }[];
}

export const v2ex: SourceAdapter = {
  id: "v2ex",
  name: "V2EX",
  group: "社区",
  homepage: "https://www.v2ex.com",
  async fetch() {
    const feeds = await Promise.all(
      ["create", "ideas", "programmer", "share"].map((k) =>
        httpJson<Res>(`https://www.v2ex.com/feed/${k}.json`),
      ),
    );
    return feeds
      .flatMap((r) => r.items)
      .map<SourceEntry>((k) => ({
        id: k.id,
        title: k.title,
        url: k.url,
        pubDate: k.date_modified || k.date_published ? Date.parse((k.date_modified ?? k.date_published) as string) || undefined : undefined,
      }))
      .sort((a, b) => (b.pubDate ?? 0) - (a.pubDate ?? 0));
  },
};
