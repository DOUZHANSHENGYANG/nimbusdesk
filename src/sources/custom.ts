/** 订阅源适配器：Rust 侧的五种源 + 内置热榜，合并成一条可排序的列表给 useFeeds。 */
import { SOURCE_LIST as SOURCE_BASE } from "./registry";
import type { SourceAdapter } from "./types";
import { useFeedOrder, useSubscriptions, type FeedSource } from "@/features/feeds/subscriptions";

/** 侧栏分组：同一 kind 的源排在一起，和订阅时的直觉一致。 */
const KIND_GROUP: Record<string, string> = {
  rss: "订阅",
  searxng: "搜索",
  "cn-social": "社区",
  page: "网页",
  opencli: "抓取",
};

export function makeSourceAdapter(source: FeedSource): SourceAdapter {
  const url = typeof source.config?.url === "string" ? source.config.url : "";
  return {
    id: source.id,
    name: source.name,
    group: KIND_GROUP[source.kind] ?? "订阅",
    homepage: url,
    async fetch() {
      return useSubscriptions.getState().run(source.id);
    },
  };
}

/**
 * 订阅源 + 内置热榜，按本机顺序（`feed-order`）排好，隐藏的不出现。
 * 内置源没有本机顺序时会排在自建源后面，落到列表末尾。
 */
export function mergedSources(): SourceAdapter[] {
  const custom = (useSubscriptions.getState().sources ?? []).map(makeSourceAdapter);
  const { order, hidden } = useFeedOrder.getState();
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...custom, ...SOURCE_BASE]
    .filter(source => !hidden.includes(source.id))
    .sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}
