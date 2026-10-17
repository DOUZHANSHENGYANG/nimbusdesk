import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "@/lib/tauri";
import { useProviders, providersReady } from "./providers";
import { cleanConnection, cleanProvider, getProviderModels, selectProvider, type AiProvider, type ChatMessage } from "./core";

export type { ChatMessage } from "./core";

function requireDesktop() {
  if (!inTauri) throw new Error("AI_DESKTOP_REQUIRED");
}

export async function saveSecret(id: string, key: string): Promise<void> {
  requireDesktop();
  await invoke("ai_save_secret", { id, key });
}

export async function hasSecret(id: string): Promise<boolean> {
  requireDesktop();
  return invoke<boolean>("ai_has_secret", { id });
}

export async function deleteSecret(id: string): Promise<void> {
  requireDesktop();
  await invoke("ai_delete_secret", { id });
}

/** Draft key is used for this request only; an empty field uses the system credential. */
export async function fetchModels(provider: Pick<AiProvider, "id" | "baseUrl">, key?: string, useStoredKey = true): Promise<string[]> {
  requireDesktop();
  return invoke<string[]>("ai_models", { input: { ...cleanConnection(provider), key: key || null, useStoredKey } });
}

export async function requestProvider(provider: AiProvider, messages: ChatMessage[], key?: string, useStoredKey = true): Promise<string> {
  requireDesktop();
  const { id, baseUrl, model, vision } = cleanProvider(provider);
  const parameters = getProviderModels(provider).find((item) => item.id === model)?.parameters;
  return invoke<string>("ai_chat", { input: { provider: { id, baseUrl, model, vision, ...(parameters && Object.keys(parameters).length ? { parameters } : {}) }, messages, ...(key ? { key } : {}), useStoredKey } });
}

export async function chatWithProvider(messages: ChatMessage[], options: { vision?: boolean } = {}): Promise<string> {
  await providersReady();
  const hasImages = messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"));
  return requestProvider(selectProvider(useProviders.getState(), options.vision || hasImages), messages);
}

export async function testProvider(provider: AiProvider, key?: string, useStoredKey = true): Promise<void> {
  await requestProvider(provider, [{ role: "user", content: "Reply with OK." }], key, useStoredKey);
}
