/**
 * searchWeb 统一入口（architecture.md 不变量：唯一搜索入口）。
 * - auto（默认）：配置了 Tavily key 用 Tavily，失败退 Bing；没 key 直接 Bing —— 零注册可用
 * - bing / tavily：强制指定
 */
import { searchTavily, type WebResult } from "./tavily";
import { searchBing } from "./providers/bing";
import { useAiSettings } from "@/stores/ai";

export type { WebResult };

export async function searchWeb(query: string, maxResults = 5): Promise<WebResult[]> {
  const provider = useAiSettings.getState().searchProvider || "auto";

  if (provider === "bing") return searchBing(query, maxResults);
  if (provider === "tavily") return searchTavily(query, maxResults);

  // auto：Tavily 优先（若有 key），失败降级 Bing
  if (useAiSettings.getState().tavilyApiKey) {
    try {
      return await searchTavily(query, maxResults);
    } catch {
      /* 降级 Bing */
    }
  }
  return searchBing(query, maxResults);
}

export { searchTavily };
