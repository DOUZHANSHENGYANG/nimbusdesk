import { cleanConnection, cleanModelId, getProviderModels, MAX_PROVIDER_MODELS, type AiProvider, type ProviderModel } from "./core.ts";

export const PROVIDER_PRESETS = [
  { id: "custom", name: "Custom", baseUrl: "", local: false },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", local: false },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", local: false },
  { id: "siliconflow", name: "SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1", local: false },
  { id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", local: true },
  { id: "lmstudio", name: "LM Studio", baseUrl: "http://localhost:1234/v1", local: true },
] as const;

/** Keep credentials and query strings intact so connection validation can reject them. */
export function normalizeBaseUrl(text: string): string {
  const trimmed = text.trim();
  if (/[?#]/.test(trimmed)) return trimmed;
  let url: URL;
  try { url = new URL(trimmed); } catch { return trimmed.replace(/\/+$/, ""); }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:chat\/completions|models)$/, "");
  return url.toString().replace(/\/+$/, "");
}

function discoveredIds(ids: string[]): string[] {
  const models = new Set<string>();
  for (const input of ids) {
    try { models.add(cleanModelId(input)); } catch { continue; }
    if (models.size === MAX_PROVIDER_MODELS) break;
  }
  return [...models];
}

type Connection = Pick<AiProvider, "id" | "baseUrl">;

/** Transport owns authentication; discovery only retries an absent compatible endpoint. */
export async function discoverModels(
  connection: Connection,
  request: (connection: Connection) => Promise<string[]>,
): Promise<{ baseUrl: string; models: string[] }> {
  let normalized = cleanConnection({ id: connection.id, baseUrl: normalizeBaseUrl(connection.baseUrl) });
  let ids: string[];
  try {
    ids = await request(normalized);
  } catch (error) {
    const code = error instanceof Error ? error.message : error;
    if ((code !== "AI_HTTP_404" && code !== "AI_HTTP_405") || new URL(normalized.baseUrl).pathname.endsWith("/v1")) throw error;
    normalized = cleanConnection({ ...normalized, baseUrl: `${normalized.baseUrl}/v1` });
    ids = await request(normalized);
  }
  const models = discoveredIds(ids);
  if (!models.length) throw new Error("AI_MODELS_EMPTY");
  return { baseUrl: normalized.baseUrl, models };
}

/** Refresh adds ids without discarding manually configured models or their settings. */
export function mergeDiscoveredModels(provider: AiProvider, ids: string[]): ProviderModel[] {
  const models = getProviderModels(provider);
  const existing = new Set(models.map((item) => item.id));
  for (const id of discoveredIds(ids)) {
    if (models.length === MAX_PROVIDER_MODELS) break;
    if (!existing.has(id)) {
      models.push({ id, vision: false });
      existing.add(id);
    }
  }
  return models;
}
