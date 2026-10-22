import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  DirectChatTransport,
  ToolLoopAgent,
  isStepCount,
  type InferAgentUIMessage,
  type LanguageModelUsage,
} from "ai";
import {
  cleanProvider,
  getProviderModels,
  selectModel,
  selectProvider,
  type AiProvider,
  type ModelParameters,
  type ProviderConfig,
} from "@/features/ai/core";
import { providersReady, useProviders } from "@/features/ai/providers";
import { agentFetch } from "./fetch";
import { agentTools } from "./tools";
import type { AgentMeta } from "./transcript";

/**
 * **唯一**知道「provider 怎么造」的地方：输入是 `AiProvider`，输出是 `ToolLoopAgent`
 * 与它的 transport，不含任何 UI 概念。
 *
 * 编排策略 v1 就这一条：`stopWhen: isStepCount(8)` —— 防跑飞的硬上限。
 */
export const AGENT_INSTRUCTIONS = [
  "你是云台（一个本机桌面工作台）里的助手。",
  "回答问题优先用中文，简洁、直接，不要复述用户的话。",
  "需要事实时用工具去查，不要凭印象编造；查不到就直说。",
  "工具返回的是本机真实数据（技能、提示词、检索结果），引用时给出名称与位置。",
  "新建技能这类写入操作会先向用户申请批准；被拒绝就停下，不要再尝试别的写入方式。",
  "最多做 8 步（含工具调用），够不着就停下来告诉用户还差什么。",
].join("\n");

/** 写类工具必须经用户批准：审批在 AI SDK 内部停住工具循环，批准后才执行。 */
const TOOL_APPROVAL = { save_skill: "user-approval" } as const;

/**
 * `DirectChatTransport` 默认把流里的错误压成一句「An error occurred.」，状态码与
 * 原始报文全丢。这里自己压成「AI_* 码 · 原始消息」一行：UI 靠前缀分类（密钥无效
 * / 限流 / 服务端错误…），人靠后半段排查。
 */
function errorLine(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const status = (error as { statusCode?: number } | null)?.statusCode;
  const code =
    typeof status === "number" ? `AI_HTTP_${status}` : /^AI_[A-Z_]+$/.test(raw) ? raw : "AI_AGENT_ERROR";
  return [code, raw === code ? "" : raw].filter(Boolean).join(" · ").slice(0, 400);
}

/* ── 选择器用的模型目录 ────────────────────────────────── */

/** 选择器里的一行：一个服务商 × 一个模型。 */
export interface ModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  vision: boolean;
  parameters: ModelParameters;
}

export function listModelOptions(config: ProviderConfig): ModelOption[] {
  const options: ModelOption[] = [];
  for (const provider of config.providers) {
    let models;
    try {
      models = getProviderModels(provider);
    } catch {
      continue; // 一条坏配置不该让整个选择器空掉
    }
    for (const model of models) {
      options.push({
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        vision: model.vision,
        parameters: model.parameters ?? {},
      });
    }
  }
  return options;
}

/**
 * 把「会话记着的 providerId + model」落成一个可用的 `AiProvider`。
 *
 * 三种边界都收在这里，且**不抛给 UI**（返回 null 表示真的一个都没有）：
 * - 记着的模型被删了 → 退回该服务商的默认模型；
 * - 记着的服务商被删了 / 配置坏了 → 退回全局默认服务商；
 * - 一个服务商都没有 → null，UI 显示引导卡。
 */
export function resolveSelection(
  config: ProviderConfig,
  providerId: string | null,
  modelId: string | null,
): AiProvider | null {
  const provider = providerId ? config.providers.find((item) => item.id === providerId) : undefined;
  if (provider) {
    try {
      return selectModel(provider, modelId ?? provider.model);
    } catch { /* 模型被删：往下退回默认模型 */ }
    try {
      return cleanProvider(provider);
    } catch { /* 服务商本身坏了：往下退回全局默认 */ }
  }
  try {
    return selectProvider(config);
  } catch {
    return null;
  }
}

export function modelParameters(provider: AiProvider): ModelParameters {
  try {
    return getProviderModels(provider).find((item) => item.id === provider.model)?.parameters ?? {};
  } catch {
    return {};
  }
}

/** 现成的默认选择；一个服务商都没有时抛 `AI_NO_PROVIDER`。 */
export async function defaultSelection(): Promise<AiProvider> {
  await providersReady();
  return selectProvider(useProviders.getState());
}

/* ── agent 与 transport ────────────────────────────────── */

/**
 * 模型参数怎么落到 AI SDK：`temperature` / `topP` / `maxTokens`（→`maxOutputTokens`）
 * 是 AI SDK 的一等字段，直接传；另外两个在请求体上改（provider 的
 * `transformRequestBody`），因为 AI SDK 没有对应名字：
 * - `tokenLimitField`：AI SDK 一律发 `max_tokens`，选了 `max_completion_tokens`
 *   就在这里改名（有些新模型只认后者）。
 * - `reasoningEffort`：AI SDK 走 providerOptions，而键名由服务商名推导、不可靠，
 *   这里直接写 `reasoning_effort`，路径最短。
 */
export function buildAgent(provider: AiProvider) {
  const parameters = modelParameters(provider);
  const factory = createOpenAICompatible({
    name: provider.name,
    baseURL: provider.baseUrl,
    // 刻意不传 apiKey：密钥由 Rust 侧按 providerId 注入，渲染进程永远看不到它。
    fetch: agentFetch(provider.id, provider.baseUrl),
    transformRequestBody: (body) => {
      if (parameters.tokenLimitField === "max_completion_tokens" && body.max_tokens != null) {
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
      }
      if (parameters.reasoningEffort) body.reasoning_effort = parameters.reasoningEffort;
      return body;
    },
  });
  return new ToolLoopAgent({
    model: factory(provider.model),
    instructions: AGENT_INSTRUCTIONS,
    tools: agentTools,
    stopWhen: isStepCount(8),
    toolApproval: TOOL_APPROVAL,
    temperature: parameters.temperature,
    topP: parameters.topP,
    maxOutputTokens: parameters.maxTokens,
  });
}

/** 会话里的消息类型：由工具表推导，UI 与 store 共用同一个类型。 */
export type AgentMessage = InferAgentUIMessage<ReturnType<typeof buildAgent>>;

/**
 * 组装 transport。
 *
 * `messageMetadata` 顺手把「这一轮用的模型 / 起算时刻 / 耗时 / 用量」写进消息的
 * metadata —— 于是每条历史消息都能显示自己的元信息，而不只是最后一条。
 */
export function buildTransport(provider: AiProvider, onUsage: (usage: LanguageModelUsage) => void) {
  const model = provider.model;
  let startedAt: number | undefined;
  return new DirectChatTransport({
    agent: buildAgent(provider),
    onError: errorLine,
    messageMetadata: ({ part }) => {
      if (part.type === "start") {
        startedAt = Date.now();
        return { createdAt: startedAt, model } satisfies AgentMeta;
      }
      if (part.type === "finish") {
        // 用量只在最后一段 finish 上是完整的（含工具轮的累计值）。
        onUsage(part.totalUsage);
        const meta: AgentMeta = { model, usage: part.totalUsage };
        if (startedAt !== undefined) {
          meta.createdAt = startedAt;
          meta.elapsedMs = Date.now() - startedAt;
        }
        startedAt = undefined;
        return meta;
      }
      return undefined;
    },
  });
}
