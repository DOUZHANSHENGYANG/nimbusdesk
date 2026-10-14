import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";

/** 资讯功能的 AI 配置（独立于全局 settings，避免污染） */
export interface AiSettings {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  /** auto = 有 Tavily key 用 Tavily 否则 Bing；bing / tavily = 强制 */
  searchProvider: string;
  tavilyApiKey: string;
}

interface AiState extends AiSettings {
  setAi: (patch: Partial<AiSettings>) => void;
}

const DEFAULTS: AiSettings = {
  llmBaseUrl: "",
  llmApiKey: "",
  llmModel: "",
  searchProvider: "auto",
  tavilyApiKey: "",
};

export const useAiSettings = create<AiState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setAi: (patch) => set(patch),
    }),
    { name: "ai-settings", storage: createJSONStorage(() => tauriJsonStorage), version: 1 },
  ),
);
