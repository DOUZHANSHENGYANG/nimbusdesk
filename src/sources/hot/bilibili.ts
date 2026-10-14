/** B站综合热门 —— JSON API（移植自 newsnow，2026-10 实测可达） */
import type { SourceAdapter, SourceEntry } from "../types";
import { httpJson } from "../http";

interface Res {
  code: number;
  data: {
    list: {
      bvid: string;
      title: string;
      desc: string;
      pubdate: number;
      owner: { name: string };
      stat: { view: number; like: number };
    }[];
  };
}

function fmt(n: number): string {
  return n >= 10000 ? `${Math.floor(n / 10000)}w+` : String(n);
}

export const bilibili: SourceAdapter = {
  id: "bilibili",
  name: "B站热门",
  group: "资讯",
  homepage: "https://www.bilibili.com/v/popular/all",
  async fetch() {
    const url = "https://api.bilibili.com/x/web-interface/popular?ps=30";
    const res = await httpJson<Res>(url);
    if (res.code !== 0) throw new Error(`B站 API code=${res.code}`);
    return res.data.list.map<SourceEntry>((v) => ({
      id: v.bvid,
      title: v.title,
      url: `https://www.bilibili.com/video/${v.bvid}`,
      pubDate: v.pubdate ? v.pubdate * 1000 : undefined,
      extra: {
        info: `${v.owner.name} · ${fmt(v.stat.view)}观看`,
        hover: v.desc,
      },
    }));
  },
};
