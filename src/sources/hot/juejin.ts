/** 掘金热文 —— JSON API（移植自 newsnow） */
import type { SourceAdapter, SourceEntry } from "../types";
import { httpJson } from "../http";

interface Res {
  data: { content: { title: string; content_id: string } }[];
}

export const juejin: SourceAdapter = {
  id: "juejin",
  name: "掘金热文",
  group: "技术",
  homepage: "https://juejin.cn",
  async fetch() {
    const url =
      "https://api.juejin.cn/content_api/v1/content/article_rank?category_id=1&type=hot&spider=0";
    const res = await httpJson<Res>(url);
    return res.data.map<SourceEntry>((k) => ({
      id: k.content.content_id,
      title: k.content.title,
      url: `https://juejin.cn/post/${k.content.content_id}`,
    }));
  },
};
