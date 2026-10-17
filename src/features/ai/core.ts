export interface ModelParameters {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  tokenLimitField?: "max_tokens" | "max_completion_tokens";
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface ProviderModel {
  id: string;
  vision: boolean;
  parameters?: ModelParameters;
}

export interface AiProvider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  vision: boolean;
  models?: ProviderModel[];
}

export const MAX_MODEL_ID_LENGTH = 512;
export const MAX_PROVIDER_MODELS = 1000;

/** Optional settings remain absent unless explicitly supplied. */
export function cleanParameters(input: unknown): ModelParameters {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("AI_INVALID_PARAMETERS");
  const values = input as Record<string, unknown>;
  const output: ModelParameters = {};
  for (const field of ["temperature", "topP", "maxTokens"] as const) {
    const value = values[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)
      || (field === "temperature" && (value < 0 || value > 2))
      || (field === "topP" && (value <= 0 || value > 1))
      || (field === "maxTokens" && (!Number.isInteger(value) || value < 1 || value > 2_000_000))) {
      throw new Error("AI_INVALID_PARAMETERS");
    }
    output[field] = value;
  }
  if (values.tokenLimitField !== undefined) {
    if (values.tokenLimitField !== "max_tokens" && values.tokenLimitField !== "max_completion_tokens") throw new Error("AI_INVALID_PARAMETERS");
    output.tokenLimitField = values.tokenLimitField;
  }
  if (values.reasoningEffort !== undefined) {
    if (typeof values.reasoningEffort !== "string" || !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(values.reasoningEffort)) throw new Error("AI_INVALID_PARAMETERS");
    output.reasoningEffort = values.reasoningEffort as ModelParameters["reasoningEffort"];
  }
  return output;
}

export function cleanModelId(input: unknown): string {
  if (typeof input !== "string" || /[\u0000-\u001f\u007f]/.test(input)) throw new Error("AI_INVALID_MODEL");
  const id = input.trim();
  if (!id || id.length > MAX_MODEL_ID_LENGTH) throw new Error("AI_INVALID_MODEL");
  return id;
}

/** Legacy providers expose their single model; blank setup drafts have none. */
export function getProviderModels(provider: AiProvider): ProviderModel[] {
  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  if (provider.models !== undefined) {
    if (!Array.isArray(provider.models) || provider.models.length > MAX_PROVIDER_MODELS) throw new Error("AI_INVALID_MODEL");
    for (const item of provider.models) {
      if (!item || typeof item !== "object") throw new Error("AI_INVALID_MODEL");
      const id = cleanModelId(item.id);
      if (seen.has(id)) continue;
      const model: ProviderModel = { id, vision: Boolean(item.vision) };
      if (item.parameters !== undefined) model.parameters = cleanParameters(item.parameters);
      models.push(model);
      seen.add(id);
    }
  }
  if (typeof provider.model !== "string") throw new Error("AI_INVALID_MODEL");
  if (provider.model.trim()) {
    const id = cleanModelId(provider.model);
    if (!seen.has(id)) models.push({ id, vision: Boolean(provider.vision) });
  }
  if (models.length > MAX_PROVIDER_MODELS) throw new Error("AI_INVALID_MODEL");
  return models;
}

export function selectModel(provider: AiProvider, modelId: string): AiProvider {
  const selectedId = cleanModelId(modelId);
  const models = getProviderModels(provider);
  const model = models.find((item) => item.id === selectedId);
  if (!model) throw new Error("AI_INVALID_MODEL");
  const { id, name, baseUrl } = provider;
  return { id, name, baseUrl, model: model.id, vision: model.vision, models };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];
}

export interface ProviderConfig {
  providers: AiProvider[];
  defaultTextId: string | null;
  defaultVisionId: string | null;
  defaultVisionModel?: string | null;
}

/** Discovery needs a connection before the user has chosen a name or model. */
export function cleanConnection(provider: Pick<AiProvider, "id" | "baseUrl">): Pick<AiProvider, "id" | "baseUrl"> {
  const { id } = provider;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) {
    throw new Error("AI_INVALID_PROVIDER");
  }
  let url: URL;
  try { url = new URL(provider.baseUrl.trim()); } catch { throw new Error("AI_INVALID_URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("AI_INVALID_URL");
  }
  return { id, baseUrl: url.toString().replace(/\/+$/, "") };
}

export function cleanProvider(provider: AiProvider): AiProvider {
  const connection = cleanConnection(provider);
  const { name, model, vision } = provider;
  if (typeof name !== "string" || !name.trim() || typeof model !== "string" || !model.trim()) {
    throw new Error("AI_INVALID_PROVIDER");
  }
  const output: AiProvider = { ...connection, name: name.trim(), model: cleanModelId(model), vision: Boolean(vision) };
  if (provider.models !== undefined) {
    output.models = getProviderModels(provider);
    output.vision = output.models.find((item) => item.id === output.model)!.vision;
  }
  return output;
}

export function selectProvider(config: ProviderConfig, vision = false): AiProvider {
  const id = vision ? config.defaultVisionId ?? config.defaultTextId : config.defaultTextId;
  const provider = config.providers.find((item) => item.id === id);
  if (!provider) throw new Error("AI_NO_PROVIDER");
  const cleaned = cleanProvider(vision && config.defaultVisionModel ? selectModel(provider, config.defaultVisionModel) : provider);
  if (vision && !cleaned.vision) throw new Error("AI_PROVIDER_NO_VISION");
  return cleaned;
}

export interface LegacyConfig {
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
}

export async function migrateLegacy(
  legacy: LegacyConfig,
  steps: {
    saveSecret: (id: string, key: string) => Promise<void>;
    saveProvider: (provider: AiProvider) => Promise<void>;
    clearLegacy: () => Promise<void>;
  },
): Promise<void> {
  const provider = cleanProvider({ id: "legacy-news", name: "News", baseUrl: legacy.llmBaseUrl, model: legacy.llmModel, vision: false });
  if (legacy.llmApiKey) await steps.saveSecret(provider.id, legacy.llmApiKey);
  await steps.saveProvider(provider);
  await steps.clearLegacy();
}
