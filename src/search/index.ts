/**
 * searchWeb 统一入口（architecture.md 不变量：唯一搜索入口）。
 * - auto（默认）：配置了 Tavily key 用 Tavily，失败退 Bing；没 key 直接 Bing —— 零注册可用
 * - bing / tavily：强制指定
 * - eos：奇妙搜索源（社区维护的搜索规则表，抓页面抽链接）
 */
import { searchTavily, type WebResult } from "./tavily";
import { searchBing } from "./providers/bing";
import { searchEos } from "./eos";
import { aiSettingsReady, useAiSettings } from "@/stores/ai";

export type { WebResult };

export async function searchWeb(query: string, maxResults = 5): Promise<WebResult[]> {
  await aiSettingsReady();
  const provider = useAiSettings.getState().searchProvider || "auto";

  if (provider === "bing") return searchBing(query, maxResults);
  if (provider === "tavily") return searchTavily(query, maxResults);
  if (provider === "eos") return (await searchEos(query, { maxResults })).results;

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

export { searchTavily, searchEos };
