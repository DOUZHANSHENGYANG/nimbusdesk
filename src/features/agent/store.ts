import { Chat } from "@ai-sdk/react";
import { isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import type { ChatStatus, LanguageModelUsage } from "ai";
import { create } from "zustand";
import { useProviders } from "@/features/ai/providers";
import { useSettings } from "@/stores/settings";
import {
  buildTransport,
  listModelOptions,
  resolveSelection,
  type AgentMessage,
  type AgentRuntime,
  type ModelOption,
} from "./model";
import { cleanGoal } from "./composer-core";
import { ensureSession, sessionsReady, useSessions, type AgentSession } from "./sessions";
import { isIncomplete, trimContext } from "./transcript";
import { buildPrompt, type Pending } from "./attachments";

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
  | "attachment"
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
    AI_INVALID_MODEL: "noProvider",
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
    AI_ATTACH_TOO_LARGE: "attachment",
    AI_ATTACH_NO_VISION: "attachment",
    AI_ATTACH_UNSUPPORTED: "attachment",
    AI_ATTACH_UNREADABLE: "attachment",
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

const busyStatus = (status: ChatStatus) => status === "submitted" || status === "streaming";

interface Live {
  chat: Chat<AgentMessage>;
  /** `providerId::model`；变了就重建 transport（AI SDK 的 transport 不可换）。 */
  key: string;
  providerId: string;
  model: string;
  off: () => void;
}

/** 每个会话一个 Chat 实例；不放进 state（它是活的、不可序列化）。 */
const live = new Map<string, Live>();

interface AgentState {
  sessionId: string;
  providerId: string | null;
  providerName: string;
  baseUrl: string;
  model: string;
  vision: boolean;
  /** 选择器要的：所有已配置服务商 × 它们的模型。 */
  options: ModelOption[];
  messages: AgentMessage[];
  status: ChatStatus;
  error: AgentError | null;
  usage: LanguageModelUsage | null;
  elapsedMs: number | null;
  /** 用户按过停止：末尾要补一行「已停止」。 */
  stopped: boolean;
  /** 上次的流没跑完（重启恢复 / 断开）。 */
  incomplete: boolean;
  /** 本轮为了塞进上下文，从最早的整轮丢了 N 条。 */
  droppedContext: number;
  starting: boolean;
  /** 没有可用服务商：输入区禁用 + 引导卡。 */
  guide: boolean;
  /** 本次会话的目标（可空）：非空时进 instructions，并在会话顶部显示一条。 */
  goal: string | null;
  init: () => Promise<void>;
  refresh: () => void;
  selectModel: (providerId: string, modelId: string) => Promise<void>;
  setGoal: (goal: string | null) => void;
  newSession: () => Promise<void>;
  openSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string | null) => void;
  removeSession: (id: string) => Promise<void>;
  clearCurrent: () => void;
  send: (text: string, attachments?: Pending[]) => Promise<void>;
  stop: () => Promise<void>;
  retry: () => Promise<void>;
  regenerate: (messageId: string) => Promise<void>;
  continueLast: () => Promise<void>;
  editMessage: (messageId: string, text: string) => Promise<void>;
  approve: (id: string, approved: boolean) => Promise<void>;
  reapprove: (id: string) => Promise<void>;
}

/** 本轮的起算时刻（不进 state，避免每个 chunk 都触发一次统计）。 */
let startedAt: number | undefined;

/** 续写：给模型的一句人话，不进会话气泡（标记 hidden）。 */
const CONTINUE_PROMPT = "继续：从你上一句中断的地方接着写，不要重复已经写过的内容，也不要重新开头。";

export const useAgent = create<AgentState>((set, get) => {
  const currentLive = () => live.get(get().sessionId);

  const sync = (sessionId: string) => {
    const entry = live.get(sessionId);
    if (!entry) return;
    const status = entry.chat.status;
    const busy = busyStatus(status);
    const finished = startedAt !== undefined && !busy;
    const elapsedMs = finished ? Date.now() - startedAt! : get().elapsedMs;
    if (finished) startedAt = undefined;
    if (sessionId === get().sessionId) {
      set({
        messages: entry.chat.messages,
        status,
        error: entry.chat.error === undefined ? null : describeError(entry.chat.error),
        elapsedMs,
      });
    }
    // 一轮结束才落盘：流式期间每个 chunk 都写会把状态文件写爆（见 sessions.ts）。
    if (finished) persist(sessionId);
  };

  const persist = (sessionId: string) => {
    const entry = live.get(sessionId);
    if (!entry) return;
    useSessions.getState().save(sessionId, {
      messages: entry.chat.messages,
      providerId: entry.providerId,
      model: entry.model,
    });
  };

  const attach = (sessionId: string, chat: Chat<AgentMessage>) => {
    const onChange = () => sync(sessionId);
    const offs = [
      chat["~registerMessagesCallback"](onChange),
      chat["~registerStatusCallback"](onChange),
      chat["~registerErrorCallback"](onChange),
    ];
    sync(sessionId);
    return () => { for (const off of offs) off(); };
  };

  /**
   * 输入区控件的当前取值。每次真正要发请求 / 要执行一个工具时才读，
   * 所以中途改权限或思考等级立刻生效，不需要重建 transport。
   */
  const runtime = (): AgentRuntime => ({
    preset: useSettings.getState().agentPreset,
    goal: get().goal,
    permission: () => useSettings.getState().agentPermission,
    thinking: () => useSettings.getState().agentThinking,
  });

  /** 会话惰性创建；服务商、模型、智能体档位或目标换了就重建 transport，已聊的消息带过去。 */
  const ensureChat = async (): Promise<Chat<AgentMessage> | null> => {
    await sessionsReady();
    const session = useSessions.getState().sessions.find((item) => item.id === get().sessionId) ?? ensureSession();
    const provider = resolveSelection(useProviders.getState(), session.providerId, session.model);
    if (!provider) {
      set({ guide: true, error: null });
      return null;
    }
    const options = runtime();
    // transport 不可换：档位与目标都烤进 instructions 了，所以它们变了必须重建。
    const key = `${provider.id}::${provider.model}::${options.preset}::${options.goal ?? ""}`;
    const existing = live.get(session.id);
    if (existing && existing.key === key) return existing.chat;

    const chat = new Chat<AgentMessage>({
      messages: existing ? existing.chat.messages : session.messages,
      transport: buildTransport(provider, options, (usage) => set({ usage })),
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    });
    if (existing) {
      existing.off();
      void existing.chat.dispose();
    }
    const off = attach(session.id, chat);
    live.set(session.id, { chat, key, providerId: provider.id, model: provider.model, off });
    applyProvider(set, provider);
    return chat;
  };

  const settle = async () => {
    const entry = currentLive();
    if (entry && busyStatus(entry.chat.status)) await entry.chat.stop();
    if (entry) persist(get().sessionId);
  };

  /**
   * 「这一轮按现在的模型 / 档位 / 目标来」的统一入口：重试、重新生成、继续都要
   * 先过一遍 ensureChat，档位或目标变过就会拿到重建后的实例（消息带过去）。
   */
  const entryForCall = async () => {
    await ensureChat();
    return currentLive();
  };

  const open = async (session: AgentSession) => {
    const config = useProviders.getState();
    const provider = resolveSelection(config, session.providerId, session.model);
    const entry = live.get(session.id);
    const messages = entry ? entry.chat.messages : session.messages;
    set({
      sessionId: session.id,
      messages,
      status: entry ? entry.chat.status : "ready",
      error: entry && entry.chat.error !== undefined ? describeError(entry.chat.error) : null,
      usage: null,
      elapsedMs: null,
      stopped: false,
      incomplete: isIncomplete(messages),
      droppedContext: 0,
      starting: false,
      guide: !provider,
      goal: session.goal ?? null,
    });
    if (provider) applyProvider(set, provider);
    else set({ providerId: null, providerName: "", baseUrl: "", model: "", vision: false });
  };

  const applyProvider = (write: typeof set, provider: { id: string; name: string; baseUrl: string; model: string; vision: boolean }) => {
    write({
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      vision: provider.vision,
      options: listModelOptions(useProviders.getState()),
      guide: false,
    });
  };

  return {
    sessionId: "",
    providerId: null,
    providerName: "",
    baseUrl: "",
    model: "",
    vision: false,
    options: [],
    messages: [],
    status: "ready",
    error: null,
    usage: null,
    elapsedMs: null,
    stopped: false,
    incomplete: false,
    droppedContext: 0,
    starting: false,
    guide: false,
    goal: null,

    init: async () => {
      await Promise.all([sessionsReady(), Promise.resolve()]);
      const session = ensureSession();
      await open(session);
    },

    refresh: () => {
      const config = useProviders.getState();
      set({ options: listModelOptions(config) });
      const current = get();
      const stillThere = current.providerId !== null && config.providers.some((item) => item.id === current.providerId);
      if (stillThere) return;
      /*
       * 当前服务商没了（设置里删了），或者本来就还没配：重新找一个可用的。
       * 注意这里不能在 guide 态提前返回 —— 用户刚在设置里加完服务商回来，
       * 正经路径就是这一次 refresh，提前返回会让面板一直卡在引导卡上。
       */
      const provider = resolveSelection(config, current.providerId, current.model);
      if (provider) applyProvider(set, provider);
      else set({ guide: true, providerId: null, providerName: "", baseUrl: "", model: "", vision: false });
    },

    selectModel: async (providerId, modelId) => {
      const config = useProviders.getState();
      const provider = resolveSelection(config, providerId, modelId);
      if (!provider) return;
      await settle(); // 生成中换模型：先停住（已生成的内容保留），再重建
      const id = get().sessionId;
      useSessions.getState().save(id, { providerId: provider.id, model: provider.model, messages: get().messages });
      applyProvider(set, provider);
      await ensureChat(); // 立刻重建：下一次发送就用新模型
    },

    /**
     * 本次目标：空串等于清除（不落一个空字符串进会话文件）。
     *
     * 不在这里重建 transport —— 目标是烤进 instructions 的，下一次 ensureChat 会
     * 因为 key 里的目标变了而重建，已聊的消息原样带过去。这里重建会让正在生成的
     * 那一轮被打断，改一个还没生效的目标不值得。
     */
    setGoal: (goal) => {
      const clean = cleanGoal(goal);
      const value = clean ? clean : null;
      if (value === get().goal) return;
      useSessions.getState().save(get().sessionId, { goal: value });
      set({ goal: value });
    },

    newSession: async () => {
      await settle();
      const provider = resolveSelection(useProviders.getState(), get().providerId, get().model);
      const session = useSessions.getState().create();
      if (provider) useSessions.getState().save(session.id, { providerId: provider.id, model: provider.model });
      await open(session);
    },

    openSession: async (id) => {
      if (id === get().sessionId) return;
      await settle();
      const session = useSessions.getState().sessions.find((item) => item.id === id);
      if (!session) return;
      useSessions.getState().setCurrent(id);
      await open(session);
    },

    renameSession: (id, title) => useSessions.getState().rename(id, title?.trim() ? title.trim() : null),

    removeSession: async (id) => {
      const entry = live.get(id);
      if (entry) {
        if (busyStatus(entry.chat.status)) await entry.chat.stop();
        entry.off();
        void entry.chat.dispose();
        live.delete(id);
      }
      const next = useSessions.getState().remove(id);
      const session = useSessions.getState().sessions.find((item) => item.id === next) ?? ensureSession();
      useSessions.getState().setCurrent(session.id);
      await open(session);
    },

    clearCurrent: () => {
      const id = get().sessionId;
      const entry = live.get(id);
      if (entry) entry.chat.messages = [];
      useSessions.getState().save(id, { messages: [] });
      startedAt = undefined;
      set({ messages: [], status: "ready", error: null, usage: null, elapsedMs: null, stopped: false, incomplete: false, droppedContext: 0 });
    },

    send: async (text, attachments = []) => {
      const trimmed = text.trim();
      if ((!trimmed && attachments.length === 0) || get().starting) return;
      set({ starting: true, stopped: false, usage: null, elapsedMs: null, error: null, incomplete: false, droppedContext: 0 });
      startedAt = undefined;
      try {
        const prompt = buildPrompt(trimmed, attachments);
        const chat = await ensureChat();
        if (!chat) return;
        // 上下文预算：超了从最早的整轮丢，并在消息上方说明丢了几条。
        const trimmedMessages = trimContext(chat.messages);
        if (trimmedMessages.messages !== chat.messages) chat.messages = trimmedMessages.messages;
        set({ droppedContext: trimmedMessages.dropped });
        startedAt = Date.now();
        await chat.sendMessage({
          text: prompt.text,
          files: prompt.files,
          metadata: { createdAt: startedAt, model: get().model, attachments: prompt.attachments, display: trimmed },
        });
      } catch (error) {
        const described = describeError(error);
        if (described.kind === "noProvider") set({ guide: true });
        else set({ error: described });
        startedAt = undefined;
      } finally {
        set({ starting: false });
        sync(get().sessionId);
      }
    },

    stop: async () => {
      const entry = currentLive();
      if (!entry || !busyStatus(entry.chat.status)) return;
      set({ stopped: true });
      /*
       * 已生成的内容会保留。Rust 侧的取消在阻塞读里要等下一个 chunk 到达才生效，
       * 所以这里表现成「已停止」而不是瞬时中断。
       */
      await entry.chat.stop();
      // 停止后这一次 send 的 finally 可能还没轮到：先把发送态放掉，否则按钮卡在「停止」
      set({ starting: false });
      sync(get().sessionId);
      persist(get().sessionId);
    },

    retry: async () => {
      const entry = await entryForCall();
      if (!entry || busyStatus(entry.chat.status)) return;
      set({ error: null, stopped: false, usage: null, elapsedMs: null, incomplete: false });
      entry.chat.clearError();
      startedAt = Date.now();
      await entry.chat.regenerate();
      sync(get().sessionId);
    },

    regenerate: async (messageId) => {
      const entry = await entryForCall();
      if (!entry || busyStatus(entry.chat.status)) return;
      set({ error: null, stopped: false, usage: null, elapsedMs: null, incomplete: false });
      entry.chat.clearError();
      startedAt = Date.now();
      // 注意：regenerate 会丢掉这条消息之后的所有内容（分支不保留）。
      await entry.chat.regenerate({ messageId });
      sync(get().sessionId);
    },

    continueLast: async () => {
      const entry = await entryForCall();
      if (!entry || busyStatus(entry.chat.status)) return;
      set({ error: null, stopped: false, usage: null, elapsedMs: null });
      startedAt = Date.now();
      await entry.chat.sendMessage({
        text: CONTINUE_PROMPT,
        metadata: { createdAt: startedAt, model: get().model, hidden: true },
      });
      sync(get().sessionId);
    },

    editMessage: async (messageId, text) => {
      const entry = currentLive();
      if (!entry) return;
      if (busyStatus(entry.chat.status)) await entry.chat.stop();
      const trimmed = text.trim();
      if (!trimmed) return;
      set({ error: null, stopped: false, usage: null, elapsedMs: null, incomplete: false });
      startedAt = Date.now();
      // 就地替换这条用户消息，AI SDK 会把它之后的内容一并丢弃（分支不保留）。
      await entry.chat.sendMessage({
        text: trimmed,
        messageId,
        metadata: { createdAt: Date.now(), model: get().model, display: trimmed },
      });
      sync(get().sessionId);
    },

    approve: async (id, approved) => {
      const entry = currentLive();
      if (!entry) return;
      await entry.chat.addToolApprovalResponse({ id, approved });
      sync(get().sessionId);
    },

    /**
     * 重新批准一个已被拒绝的工具。AI SDK 只认 `approval-requested` 的那次响应，
     * 所以先把这条 part 的状态退回 `approval-requested`，再走正常批准。
     */
    reapprove: async (id) => {
      const entry = currentLive();
      if (!entry) return;
      entry.chat.messages = entry.chat.messages.map((message) => ({
        ...message,
        parts: message.parts.map((part) => (
          isToolUIPart(part) && part.state === "output-denied" && part.approval?.id === id
            ? { ...part, state: "approval-requested" as const }
            : part
        )),
      })) as AgentMessage[];
      await entry.chat.addToolApprovalResponse({ id, approved: true });
      sync(get().sessionId);
    },
  };
});

// 服务商在设置里被改了（加了/删了/换了默认）：选择器与当前会话立刻跟上。
useProviders.subscribe(() => useAgent.getState().refresh());

/** 导出会话时用的快照：消息取运行态里最新的那份，服务商/模型取当前选择。 */
export function sessionForExport(): AgentSession | null {
  const state = useAgent.getState();
  const session = useSessions.getState().sessions.find((item) => item.id === state.sessionId);
  if (!session) return null;
  return { ...session, messages: state.messages, model: state.model || session.model, providerId: state.providerId };
}
