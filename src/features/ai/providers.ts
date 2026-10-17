import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { flushAllStorage, onStorageSynced, tauriJsonStorage } from "@/lib/storage";
import { cleanProvider, getProviderModels, type AiProvider, type ProviderConfig } from "./core";

export type { AiProvider, ChatMessage, ProviderConfig } from "./core";

interface ProvidersState extends ProviderConfig {
  saveProvider: (provider: AiProvider) => void;
  removeProvider: (id: string) => void;
  setDefault: (kind: "text" | "vision", id: string | null) => void;
  setVisionDefault: (id: string | null, model: string | null) => void;
}

export const useProviders = create<ProvidersState>()(
  persist(
    (set) => ({
      providers: [],
      defaultTextId: null,
      defaultVisionId: null,
      defaultVisionModel: null,
      saveProvider: (input) => {
        const provider = cleanProvider(input);
        set((s) => {
          const imageValid = s.defaultVisionId !== provider.id || getProviderModels(provider).some((model) => model.id === (s.defaultVisionModel ?? provider.model) && model.vision);
          return {
            providers: s.providers.some((p) => p.id === provider.id)
              ? s.providers.map((p) => p.id === provider.id ? provider : p)
              : [...s.providers, provider],
            defaultTextId: s.defaultTextId ?? provider.id,
            defaultVisionId: imageValid ? s.defaultVisionId : null,
            defaultVisionModel: imageValid ? s.defaultVisionModel : null,
          };
        });
      },
      removeProvider: (id) => set((s) => ({
        providers: s.providers.filter((p) => p.id !== id),
        defaultTextId: s.defaultTextId === id ? null : s.defaultTextId,
        defaultVisionId: s.defaultVisionId === id ? null : s.defaultVisionId,
        defaultVisionModel: s.defaultVisionId === id ? null : s.defaultVisionModel,
      })),
      setDefault: (kind, id) => set((s) => {
        if (id && !s.providers.some((p) => p.id === id && (kind !== "vision" || p.vision))) {
          throw new Error("AI_NO_PROVIDER");
        }
        return kind === "text" ? { defaultTextId: id } : { defaultVisionId: id, defaultVisionModel: null };
      }),
      setVisionDefault: (id, model) => set((s) => {
        if (id && !s.providers.some((provider) => provider.id === id && getProviderModels(provider).some((item) => item.id === model && item.vision))) throw new Error("AI_PROVIDER_NO_VISION");
        return { defaultVisionId: id, defaultVisionModel: id ? model : null };
      }),
    }),
    {
      name: "ai-providers",
      storage: createJSONStorage(() => tauriJsonStorage),
      version: 1,
      partialize: (s) => ({
        providers: s.providers.map(cleanProvider),
        defaultTextId: s.defaultTextId,
        defaultVisionId: s.defaultVisionId,
        defaultVisionModel: s.defaultVisionModel ?? null,
      }),
      merge: (persisted, current) => {
        const data = persisted as Partial<ProviderConfig> | undefined;
        const providers: AiProvider[] = [];
        for (const item of Array.isArray(data?.providers) ? data.providers : []) {
          try { providers.push(cleanProvider(item)); } catch { /* Skip malformed entries without affecting working providers. */ }
        }
        return { ...current, providers, defaultTextId: typeof data?.defaultTextId === "string" ? data.defaultTextId : null, defaultVisionId: typeof data?.defaultVisionId === "string" ? data.defaultVisionId : null, defaultVisionModel: typeof data?.defaultVisionModel === "string" ? data.defaultVisionModel : null };
      },
    },
  ),
);

onStorageSynced((key) => {
  if (key === "ai-providers") void useProviders.persist.rehydrate();
});

export async function providersReady(): Promise<void> {
  if (useProviders.persist.hasHydrated()) return;
  await new Promise<void>((resolve) => {
    const off = useProviders.persist.onFinishHydration(() => { off(); resolve(); });
    if (useProviders.persist.hasHydrated()) { off(); resolve(); }
  });
}

/** Wait for the disk write before a settings form reports success. */
export async function persistProviders(): Promise<void> {
  // Zustand already enqueues the complete state. A second direct write races
  // the queued snapshot and can undo a just-selected default model.
  await flushAllStorage();
}
