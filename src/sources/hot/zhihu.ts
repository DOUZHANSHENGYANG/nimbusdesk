/** 知乎热榜 —— JSON API（移植自 newsnow，2026-10 实测可达） */
import type { SourceAdapter, SourceEntry } from "../types";
import { httpJson } from "../http";

interface Res {
  data: {
    target: {
      title_area: { text: string };
      excerpt_area: { text: string };
      metrics_area: { text: string };
      link: { url: string };
    };
  }[];
}

export const zhihu: SourceAdapter = {
  id: "zhihu",
  name: "知乎热榜",
  group: "资讯",
  homepage: "https://www.zhihu.com/hot",
  async fetch() {
    const url = "https://www.zhihu.com/api/v3/feed/topstory/hot-list-web?limit=30&desktop=true";
    const res = await httpJson<Res>(url);
    return res.data.map<SourceEntry>((k) => ({
      id: k.target.link.url.match(/(\d+)$/)?.[1] ?? k.target.link.url,
      title: k.target.title_area.text,
      url: k.target.link.url,
      extra: {
        info: k.target.metrics_area.text || undefined,
        hover: k.target.excerpt_area.text,
      },
    }));
  },
};
