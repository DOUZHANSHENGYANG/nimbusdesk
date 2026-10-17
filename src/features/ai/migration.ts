import { writeJson } from "@/lib/tauri";
import { invoke } from "@tauri-apps/api/core";
import { useAiSettings, aiSettingsReady } from "@/stores/ai";
import { useProviders, providersReady } from "./providers";
import { cleanProvider, migrateLegacy, type ProviderConfig } from "./core";
import { saveSecret } from "./client";

/** Explicit user action. Credentials and provider config must be durable before plaintext is removed. */
export async function migrateLegacySettings(): Promise<void> {
  await Promise.all([aiSettingsReady(), providersReady()]);
  const old = useAiSettings.getState();
  const current = useProviders.getState();
  const legacyProvider = cleanProvider({ id: "legacy-news", name: "News", baseUrl: old.llmBaseUrl, model: old.llmModel, vision: false });
  const existing = current.providers.find((p) => p.id === legacyProvider.id);
  // Validate conflicts before writing the credential, so retries cannot overwrite another provider's key.
  if (existing && (existing.baseUrl !== legacyProvider.baseUrl || existing.model !== legacyProvider.model)) {
    throw new Error("AI_MIGRATION_PROVIDER_CONFLICT");
  }
  let next: ProviderConfig | undefined;
  await migrateLegacy(old, {
    saveSecret,
    saveProvider: async (provider) => {
      next = {
        providers: existing ? current.providers : [...current.providers, provider],
        defaultTextId: current.defaultTextId ?? provider.id,
        defaultVisionId: current.defaultVisionId,
        defaultVisionModel: current.defaultVisionModel ?? null,
      };
      await writeJson("ai-providers", { state: next, version: 1 });
    },
    clearLegacy: async () => {
      try {
        await invoke("ai_finalize_legacy_migration", { id: "legacy-news" });
      } catch {
        const { providers, defaultTextId, defaultVisionId, defaultVisionModel } = current;
        await writeJson("ai-providers", { state: { providers, defaultTextId, defaultVisionId, defaultVisionModel: defaultVisionModel ?? null }, version: 1 }).catch(() => undefined);
        throw new Error("AI_MIGRATION_WRITE_FAILED");
      }
      useAiSettings.getState().setAi({ llmApiKey: "" });
    },
  });
  if (next) useProviders.setState(next);
}
