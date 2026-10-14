/** 少数派热门 —— JSON API（移植自 newsnow） */
import type { SourceAdapter, SourceEntry } from "../types";
import { httpJson } from "../http";

interface Res {
  data: { id: number; title: string }[];
}

export const sspai: SourceAdapter = {
  id: "sspai",
  name: "少数派",
  group: "资讯",
  homepage: "https://sspai.com",
  async fetch() {
    const timestamp = Date.now();
    const url = `https://sspai.com/api/v1/article/tag/page/get?limit=30&offset=0&created_at=${timestamp}&tag=%E7%83%AD%E9%97%A8%E6%96%87%E7%AB%A0&released=false`;
    const res = await httpJson<Res>(url);
    return res.data.map<SourceEntry>((k) => ({
      id: String(k.id),
      title: k.title,
      url: `https://sspai.com/post/${k.id}`,
    }));
  },
};
