/** 自定义 RSS 订阅：JSON 持久化（tauriJsonStorage）+ 动态适配器工厂 */
import { fetchRssEntries } from "./rss";
import { SOURCE_LIST as SOURCE_BASE } from "./registry";
import type { SourceAdapter } from "./types";
import { useCustomFeeds, type CustomFeed } from "@/stores/custom-feeds";

export type { CustomFeed };

export function makeRssAdapter(feed: CustomFeed): SourceAdapter {
  return {
    id: feed.id,
    name: feed.name,
    group: feed.group,
    homepage: feed.url,
    async fetch() {
      return fetchRssEntries(feed.url);
    },
  };
}

/** 静态注册表 + 自定义订阅合并 */
export function mergedSources(): SourceAdapter[] {
  const custom = useCustomFeeds.getState().feeds.map(makeRssAdapter);
  return [...SOURCE_BASE, ...custom.filter((c) => !SOURCE_BASE.some((s) => s.id === c.id))];
}
