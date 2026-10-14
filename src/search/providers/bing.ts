/**
 * Bing 网页搜索 —— 免注册 HTML 抓取（searchWeb 的零门槛实现）。
 * 2026-10 实测：cn.bing.com 国内可达，li.b_algo > h2>a + p 结构稳定。
 */
import type { WebResult } from "../tavily";
import { httpText } from "@/sources/http";

export async function searchBing(query: string, maxResults = 5): Promise<WebResult[]> {
  const q = encodeURIComponent(query);
  const hosts = ["https://cn.bing.com", "https://www.bing.com"];

  for (const host of hosts) {
    try {
      const html = await httpText(`${host}/search?q=${q}&count=${Math.max(maxResults, 10)}&mkt=zh-CN`);
      const doc = new DOMParser().parseFromString(html, "text/html");
      const items = Array.from(doc.querySelectorAll("li.b_algo"));

      const results: WebResult[] = [];
      for (const li of items) {
        const a = li.querySelector("h2 a");
        const href = a?.getAttribute("href") ?? "";
        const title = (a?.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!href.startsWith("http") || !title) continue;
        const content =
          (li.querySelector("p")?.textContent ?? "").replace(/\s+/g, " ").trim() ?? "";
        results.push({ title, url: href, content });
        if (results.length >= maxResults) break;
      }
      if (results.length) return results;
    } catch {
      /* 换下一个 host */
    }
  }
  throw new Error("Bing 搜索失败（无结果或网络不可达）");
}
