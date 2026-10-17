import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { onStorageSynced, tauriJsonStorage } from "@/lib/storage";

/** 资讯联网搜索配置；llm 字段仅保留用于旧配置迁移，模型调用统一使用 ai-providers。 */
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

onStorageSynced((key) => {
  if (key === "ai-settings") void useAiSettings.persist.rehydrate();
});

export async function aiSettingsReady(): Promise<void> {
  if (useAiSettings.persist.hasHydrated()) return;
  await new Promise<void>((resolve) => {
    const off = useAiSettings.persist.onFinishHydration(() => { off(); resolve(); });
    if (useAiSettings.persist.hasHydrated()) { off(); resolve(); }
  });
}
