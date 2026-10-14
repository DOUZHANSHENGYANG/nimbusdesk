/** Tavily 搜索 API（searchWeb 的第一个实现；抽象见 architecture.md 不变量） */
import { rawFetch } from "@/sources/http";
import { useAiSettings } from "@/stores/ai";

export interface WebResult {
  title: string;
  url: string;
  content: string;
}

const API = "https://api.tavily.com";

async function tavilyPost(path: string, body: Record<string, unknown>) {
  const { tavilyApiKey } = useAiSettings.getState();
  if (!tavilyApiKey) throw new Error("Tavily Key 未配置：tavily.com 免费注册后填入设置");
  const res = await rawFetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: tavilyApiKey, ...body }),
  });
  if (!res.ok) throw new Error(`Tavily ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return res.json();
}

export async function searchTavily(query: string, maxResults = 5): Promise<WebResult[]> {
  const data = await tavilyPost("/search", {
    query,
    max_results: maxResults,
    search_depth: "basic",
    include_answer: false,
  });
  return ((data as any)?.results ?? []).map((r: any) => ({
    title: r.title ?? r.url,
    url: r.url,
    content: r.content ?? "",
  }));
}

/** 抓取单页正文（AI 单条摘要用）：有 Tavily key 用 extract，没有则直连抓取去标签 */
export async function extractUrl(url: string): Promise<string> {
  if (useAiSettings.getState().tavilyApiKey) {
    const data = await tavilyPost("/extract", { urls: [url] });
    return (data as any)?.results?.[0]?.raw_content ?? "";
  }
  // 兜底：直连抓 HTML，剥掉脚本/样式/标签
  const { httpText } = await import("@/sources/http");
  const html = await httpText(url);
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
