import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  DirectChatTransport,
  ToolLoopAgent,
  isStepCount,
  type InferAgentUIMessage,
  type LanguageModelUsage,
} from "ai";
import { selectProvider, type AiProvider } from "@/features/ai/core";
import { providersReady, useProviders } from "@/features/ai/providers";
import { agentFetch } from "./fetch";
import { agentTools } from "./tools";

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

/** 现成的默认服务商选择逻辑（缺默认项时抛 `AI_NO_PROVIDER`）。 */
export async function currentProvider(): Promise<AiProvider> {
  await providersReady();
  return selectProvider(useProviders.getState());
}

function buildAgent(provider: AiProvider) {
  const model = createOpenAICompatible({
    name: provider.name,
    baseURL: provider.baseUrl,
    fetch: agentFetch(provider.id, provider.baseUrl),
  })(provider.model);
  return new ToolLoopAgent({
    model,
    instructions: AGENT_INSTRUCTIONS,
    tools: agentTools,
    stopWhen: isStepCount(8),
    toolApproval: TOOL_APPROVAL,
  });
}

/** 会话里的消息类型：由工具表推导，UI 与 store 共用同一个类型。 */
export type AgentMessage = InferAgentUIMessage<ReturnType<typeof buildAgent>>;

/**
 * 组装 transport。
 * 刻意**不传 apiKey**：密钥由 Rust 侧按 providerId 注入，渲染进程永远看不到它。
 */
export function buildTransport(
  provider: AiProvider,
  onUsage: (usage: LanguageModelUsage) => void,
) {
  return new DirectChatTransport({
    agent: buildAgent(provider),
    onError: errorLine,
    // 用量只在最后一段 finish 上是完整的（含工具轮的累计值）。
    messageMetadata: ({ part }) => {
      if (part.type === "finish") onUsage(part.totalUsage);
      return undefined;
    },
  });
}
