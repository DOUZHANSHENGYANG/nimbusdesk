import { Chat } from "@ai-sdk/react";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import type { ChatStatus, LanguageModelUsage } from "ai";
import { create } from "zustand";
import { buildTransport, currentProvider, type AgentMessage } from "./model";

/** 归一化后的错误类别：UI 只用它去查一句人话，原始报文另存。 */
export type AgentErrorKind =
  | "noProvider"
  | "network"
  | "timeout"
  | "auth"
  | "rateLimit"
  | "server"
  | "origin"
  | "tooLarge"
  | "noDesktop"
  | "unknown";

export interface AgentError {
  kind: AgentErrorKind;
  detail: string;
}

/**
 * 错误以「AI_* 码 · 原始消息」一行到达（见 `model.ts::errorLine`）：前段用来分类，
 * 后段留给排查。带状态码的那类由模型层压成 `AI_HTTP_<代码>`。
 */
function describeError(error: unknown): AgentError {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  const code = detail.split(" · ")[0];
  const known: Record<string, AgentErrorKind> = {
    AI_NO_PROVIDER: "noProvider",
    AI_INVALID_PROVIDER: "noProvider",
    AI_NETWORK_ERROR: "network",
    AI_STREAM_TIMEOUT: "timeout",
    AI_ORIGIN_MISMATCH: "origin",
    AI_INVALID_URL: "origin",
    AI_INVALID_HEADERS: "origin",
    AI_INVALID_METHOD: "origin",
    AI_INVALID_KEY: "auth",
    AI_RESPONSE_TOO_LARGE: "tooLarge",
    AI_REQUEST_TOO_LARGE: "tooLarge",
    AI_NO_DESKTOP: "noDesktop",
  };
  if (code === "AI_HTTP_401" || code === "AI_HTTP_403") return { kind: "auth", detail };
  if (code === "AI_HTTP_429") return { kind: "rateLimit", detail };
  if (code.startsWith("AI_HTTP_")) return { kind: "server", detail };
  /*
   * 响应体读到一半失败（Rust 的 err 事件、前端看门狗超时）时，AI SDK 会把原始
   * 错误换掉，只说这一句 —— 拿不到具体码，按「网络/连接断了」处理。
   */
  if (detail.startsWith("Failed to process successful response")) return { kind: "network", detail };
  return { kind: known[code] ?? "unknown", detail };
}

interface AgentState {
  chat: Chat<AgentMessage> | null;
  providerId: string | null;
  providerName: string;
  model: string;
  /** 会话内容：唯一持有者是这个 store，UI 全部是无状态渲染。 */
  messages: AgentMessage[];
  status: ChatStatus;
  error: AgentError | null;
  usage: LanguageModelUsage | null;
  elapsedMs: number | null;
  /** 用户按过停止：末尾要补一行「已停止」。 */
  stopped: boolean;
  starting: boolean;
  /** 没有可用服务商：输入区禁用 + 引导卡。 */
  guide: boolean;
  init: () => Promise<void>;
  send: (text: string) => Promise<void>;
  stop: () => Promise<void>;
  retry: () => Promise<void>;
  approve: (id: string, approved: boolean) => Promise<void>;
  reset: () => void;
}

/** 本轮的起算时刻（不进 state，避免每个 chunk 都触发一次统计）。 */
let startedAt: number | undefined;

export const useAgent = create<AgentState>((set, get) => {
  const sync = (chat: Chat<AgentMessage>) => {
    const status = chat.status;
    const finished = startedAt !== undefined && status !== "submitted" && status !== "streaming";
    const elapsedMs = finished ? Date.now() - startedAt! : get().elapsedMs;
    if (finished) startedAt = undefined;
    set({
      messages: chat.messages,
      status,
      error: chat.error === undefined ? null : describeError(chat.error),
      elapsedMs,
    });
  };

  const attach = (chat: Chat<AgentMessage>) => {
    chat["~registerMessagesCallback"](() => sync(chat));
    chat["~registerStatusCallback"](() => sync(chat));
    chat["~registerErrorCallback"](() => sync(chat));
    sync(chat);
  };

  /**
   * 会话惰性创建：第一次发送时才去解析服务商。
   * 服务商换了（设置里改了默认项）就重建 transport，已聊的消息带过去接着聊。
   */
  const ensureChat = async (): Promise<Chat<AgentMessage>> => {
    const provider = await currentProvider();
    const existing = get().chat;
    if (existing && get().providerId === provider.id) return existing;
    const chat = new Chat<AgentMessage>({
      messages: existing?.messages ?? [],
      transport: buildTransport(provider, (usage) => set({ usage })),
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    });
    attach(chat);
    set({
      chat,
      providerId: provider.id,
      providerName: provider.name,
      model: provider.model,
      messages: chat.messages,
      guide: false,
    });
    return chat;
  };

  const readProvider = async () => {
    try {
      const provider = await currentProvider();
      set({
        providerId: provider.id,
        providerName: provider.name,
        model: provider.model,
        guide: false,
      });
    } catch (error) {
      const described = describeError(error);
      set({ guide: true, error: described.kind === "noProvider" ? null : described });
    }
  };

  return {
    chat: null,
    providerId: null,
    providerName: "",
    model: "",
    messages: [],
    status: "ready",
    error: null,
    usage: null,
    elapsedMs: null,
    stopped: false,
    starting: false,
    guide: false,

    init: readProvider,

    send: async (text) => {
      const trimmed = text.trim();
      if (!trimmed || get().starting) return;
      set({ starting: true, stopped: false, usage: null, elapsedMs: null, error: null });
      startedAt = undefined;
      try {
        const chat = await ensureChat();
        startedAt = Date.now();
        await chat.sendMessage({ text: trimmed });
      } catch (error) {
        const described = describeError(error);
        if (described.kind === "noProvider") set({ guide: true });
        else set({ error: described });
        startedAt = undefined;
      } finally {
        set({ starting: false });
        const chat = get().chat;
        if (chat) sync(chat);
      }
    },

    stop: async () => {
      const chat = get().chat;
      if (!chat || (chat.status !== "submitted" && chat.status !== "streaming")) return;
      set({ stopped: true });
      /*
       * 已生成的内容会保留。Rust 侧的取消在阻塞读里要等下一个 chunk 到达才生效，
       * 所以这里表现成「已停止」而不是瞬时中断。
       */
      await chat.stop();
      sync(chat);
    },

    retry: async () => {
      const chat = get().chat;
      if (!chat || chat.status === "submitted" || chat.status === "streaming") return;
      set({ error: null, stopped: false, usage: null, elapsedMs: null });
      chat.clearError();
      startedAt = Date.now();
      await chat.regenerate();
      sync(chat);
    },

    approve: async (id, approved) => {
      const chat = get().chat;
      if (!chat) return;
      await chat.addToolApprovalResponse({ id, approved });
      sync(chat);
    },

    reset: () => {
      const chat = get().chat;
      if (chat) chat.messages = [];
      startedAt = undefined;
      set({ messages: [], status: "ready", error: null, usage: null, elapsedMs: null, stopped: false });
    },
  };
});
