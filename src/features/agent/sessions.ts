import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";
import type { AgentMessage } from "./model";
import { stripFiles, type AgentMeta } from "./transcript";

export type { AgentMeta, AgentAttachmentMeta } from "./transcript";
export { firstUserText, metaOf, messageText, sessionTitle, stripFiles, toMarkdown } from "./transcript";

/**
 * 会话记录：这是**唯一**落盘的东西（面板元数据 + 消息）。
 *
 * 为什么消息不跟运行态放一个 store：运行态每来一个流式 chunk 就 `set` 一次，
 * 而 `tauriJsonStorage` 每次 `set` 都要把整份状态 JSON 解析 + 序列化一遍。
 * 一次长回答会产生几百次无意义的读写。所以消息在运行态里实时更新，只在
 * 「一轮结束 / 用户主动落盘」时**整份拷贝**进这里，一次回合一次写。
 */
export interface AgentSession {
  id: string;
  /** 手动改过的标题；null = 跟随首条用户消息。 */
  title: string | null;
  /** 上次这一轮用的服务商与模型；下次打开会话接着用。 */
  providerId: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  messages: AgentMessage[];
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

interface SessionsState {
  sessions: AgentSession[];
  currentId: string;
  create: () => AgentSession;
  setCurrent: (id: string) => void;
  rename: (id: string, title: string | null) => void;
  remove: (id: string) => string;
  /** 整份写回一条会话（消息 + 本轮用的模型）。 */
  save: (id: string, patch: Partial<Omit<AgentSession, "id">>) => void;
}

function blank(): AgentSession {
  const now = Date.now();
  return { id: newSessionId(), title: null, providerId: null, model: null, createdAt: now, updatedAt: now, messages: [] };
}

export const useSessions = create<SessionsState>()(
  persist(
    (set, get) => ({
      sessions: [],
      currentId: "",

      create: () => {
        const session = blank();
        set((s) => ({ sessions: [session, ...s.sessions], currentId: session.id }));
        return session;
      },

      setCurrent: (id) => set((s) => (s.sessions.some((item) => item.id === id) ? { currentId: id } : s)),

      rename: (id, title) => set((s) => ({
        sessions: s.sessions.map((item) => item.id === id ? { ...item, title, updatedAt: Date.now() } : item),
      })),

      remove: (id) => {
        const rest = get().sessions.filter((item) => item.id !== id);
        const next = rest[0] ?? blank();
        set({ sessions: rest.length ? rest : [next], currentId: next.id });
        return next.id;
      },

      save: (id, patch) => set((s) => ({
        sessions: s.sessions.some((item) => item.id === id)
          ? s.sessions.map((item) => item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item)
          : [{ ...blank(), id, ...patch }, ...s.sessions],
      })),
    }),
    {
      name: "ai-agent",
      storage: createJSONStorage(() => tauriJsonStorage),
      version: 1,
      /**
       * 只留会话本身。手改坏的一条记录不该让整个面板打不开，所以水合时逐条
       * 校验、丢掉坏的那条，其余照常。
       */
      partialize: (s) => ({
        currentId: s.currentId,
        sessions: s.sessions.map((item) => ({ ...item, messages: stripFiles(item.messages) })),
      }),
      merge: (persisted, current) => {
        const data = persisted as { sessions?: unknown; currentId?: unknown } | undefined;
        const sessions: AgentSession[] = [];
        for (const raw of Array.isArray(data?.sessions) ? data.sessions : []) {
          const item = raw as Partial<AgentSession>;
          if (!item || typeof item.id !== "string" || !Array.isArray(item.messages)) continue;
          sessions.push({
            id: item.id,
            title: typeof item.title === "string" ? item.title : null,
            providerId: typeof item.providerId === "string" ? item.providerId : null,
            model: typeof item.model === "string" ? item.model : null,
            createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
            updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
            messages: item.messages as AgentMessage[],
          });
        }
        const currentId = typeof data?.currentId === "string" && sessions.some((item) => item.id === data.currentId)
          ? data.currentId
          : sessions[0]?.id ?? "";
        return { ...current, sessions, currentId };
      },
    },
  ),
);

export async function sessionsReady(): Promise<void> {
  if (useSessions.persist.hasHydrated()) return;
  await new Promise<void>((resolve) => {
    const off = useSessions.persist.onFinishHydration(() => { off(); resolve(); });
    if (useSessions.persist.hasHydrated()) { off(); resolve(); }
  });
}

/** 取当前会话；没有就现建一个（首次打开面板时用）。 */
export function ensureSession(): AgentSession {
  const state = useSessions.getState();
  const found = state.sessions.find((item) => item.id === state.currentId);
  if (found) return found;
  if (state.sessions.length) {
    useSessions.getState().setCurrent(state.sessions[0].id);
    return state.sessions[0];
  }
  return state.create();
}

export type { AgentMeta as AgentMessageMeta };
