/**
 * 会话文本的纯函数：裁剪上下文、落盘去重、导出 Markdown、推导标题。
 *
 * 这里**刻意不 import 任何东西**（连 type import 都不用）：这些函数是「会悄悄
 * 弄丢用户内容」的地方，必须能脱离浏览器与 zustand 直接用 `node --test` 验。
 * 类型用结构化的最小形状，`AgentMessage` 天然满足。
 */

export interface TranscriptPart {
  type?: string;
  text?: string;
  url?: string;
  mediaType?: string;
  filename?: string;
  state?: string;
  toolName?: string;
  output?: unknown;
  errorText?: string;
}

export interface TranscriptMessage {
  id: string;
  role: string;
  parts: readonly TranscriptPart[];
  metadata?: unknown;
}

export interface AgentAttachmentMeta {
  name: string;
  kind: "image" | "text";
  size: number;
  /** 是否随会话保存在磁盘上（图片超过阈值会被丢弃，见 `stripFiles`）。 */
  kept: boolean;
}

/** 一条消息的元信息，读写都在 UI 侧转换成它。 */
export interface AgentMeta {
  createdAt?: number;
  model?: string;
  elapsedMs?: number;
  usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } | null;
  /** 系统插入的提示轮（例如「继续生成」），不在会话里显示成用户气泡。 */
  hidden?: boolean;
  attachments?: AgentAttachmentMeta[];
}

export function metaOf(message: { metadata?: unknown }): AgentMeta {
  return (message.metadata ?? {}) as AgentMeta;
}

/** 消息正文：只取 text part，用于标题、复制与导出。 */
export function messageText(message: TranscriptMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/** 一条会话的显示标题：用户改过就用用户的，否则取首条用户消息。 */
export function firstUserText(messages: readonly TranscriptMessage[]): string {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = messageText(message).replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return "";
}

export function sessionTitle(session: { title?: string | null; messages: readonly TranscriptMessage[] }, fallback: string): string {
  const text = session.title ?? firstUserText(session.messages);
  if (!text) return fallback;
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/**
 * 图片附件落盘阈值（data URL 长度）。超过就**不写盘**，只留一条元信息。
 *
 * 取舍：图片以 base64 存进 SQLite 的状态 JSON，一张 1 MB 的图约 1.4 MB 文本，
 * 会话一多会把状态文件拖到几十 MB；而这些历史图片本来也不再参与后续推理。
 * （附件不落盘 = 重开会话后那张图消失，元信息里会标「未随会话保存」。）
 */
export const FILE_PERSIST_LIMIT = 48 * 1024;

export function stripFiles<T extends { parts: readonly TranscriptPart[]; metadata?: unknown }>(messages: T[]): T[] {
  return messages.map((message) => {
    const dropped = message.parts.some((part) => part.type === "file" && (part.url ?? "").length > FILE_PERSIST_LIMIT);
    if (!dropped) return message;
    const meta = metaOf(message);
    return {
      ...message,
      parts: message.parts.filter((part) => part.type !== "file" || (part.url ?? "").length <= FILE_PERSIST_LIMIT),
      metadata: meta.attachments
        ? { ...meta, attachments: meta.attachments.map((item) => item.kind === "image" ? { ...item, kept: false } : item) }
        : meta,
    };
  });
}

/* ── 上下文预算 ────────────────────────────────────────── */

/** 估算用的字符预算（≈ 60k tokens）。超了就从最早的整轮开始丢。 */
export const CONTEXT_BUDGET_CHARS = 240_000;

/** 一条消息大约占多少字符：文本 + 附件 + 工具结果都算进去。 */
export function messageChars(message: { parts: readonly TranscriptPart[] }): number {
  let total = 0;
  for (const part of message.parts) {
    if (typeof part.text === "string") total += part.text.length;
    if (typeof part.url === "string") total += part.url.length;
    if (part.output !== undefined) total += JSON.stringify(part.output ?? null).length;
    if (typeof part.errorText === "string") total += part.errorText.length;
  }
  return total;
}

/**
 * 超预算时从**最早的整轮**开始丢：只在用户消息处下刀，最后一条用户消息
 * （以及它后面的助手回复）一定保留，不会把一轮拆成两半。
 * 返回丢了几条，UI 据此提示「已省略最早的 N 条」。
 */
export function trimContext<T extends { role: string; parts: readonly TranscriptPart[] }>(
  messages: T[],
  budget = CONTEXT_BUDGET_CHARS,
): { messages: T[]; dropped: number } {
  const sizes = messages.map(messageChars);
  let total = sizes.reduce((a, b) => a + b, 0);
  if (total <= budget) return { messages, dropped: 0 };
  let drop = 0;
  for (let cut = 1; cut < messages.length && total > budget; cut++) {
    if (messages[cut].role !== "user") continue;
    for (let i = drop; i < cut; i++) total -= sizes[i];
    drop = cut;
  }
  return drop ? { messages: messages.slice(drop), dropped: drop } : { messages, dropped: 0 };
}

/**
 * 上次是被中断的吗：AI SDK 的流没有「收尾」时，最后一条会是用户消息，
 * 或者助手消息里还留着没收尾的工具调用。用来显示「上次未完成」+ 续写。
 */
export function isIncomplete(messages: readonly TranscriptMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last) return false;
  if (last.role === "user") return true;
  return last.parts.some((part) => part.state === "input-streaming" || part.state === "input-available");
}

/* ── 导出 ─────────────────────────────────────────────── */

export interface ExportSession {
  id: string;
  title?: string | null;
  providerId?: string | null;
  model?: string | null;
  createdAt?: number;
  messages: readonly TranscriptMessage[];
}

const stamp = (ms: number | undefined) => (ms ? new Date(ms).toLocaleString() : "");
const isToolPart = (part: TranscriptPart) =>
  part.type === "dynamic-tool" || (part.type ?? "").startsWith("tool-");

/** 导出为 Markdown：给人看的，工具调用压成代码块。 */
export function toMarkdown(session: ExportSession, labels: { user: string; assistant: string; tool: string }): string {
  const lines: string[] = [`# ${sessionTitle(session, session.id)}`, ""];
  const head = [session.providerId, session.model, stamp(session.createdAt)].filter(Boolean).join(" · ");
  if (head) lines.push(`> ${head}`, "");
  for (const message of session.messages) {
    const meta = metaOf(message);
    if (meta.hidden) continue;
    const time = stamp(meta.createdAt);
    lines.push(`## ${message.role === "user" ? labels.user : labels.assistant}${time ? ` · ${time}` : ""}`, "");
    for (const part of message.parts) {
      if (part.type === "text") {
        if (part.text?.trim()) lines.push(part.text, "");
        continue;
      }
      if (part.type === "reasoning") {
        if (part.text?.trim()) lines.push("<details><summary>reasoning</summary>", "", part.text, "", "</details>", "");
        continue;
      }
      if (part.type === "file") {
        lines.push(`- ${labels.tool}: ${part.filename ?? part.mediaType ?? ""}`);
        continue;
      }
      if (isToolPart(part)) {
        const name = (part.toolName ?? (part.type ?? "").slice("tool-".length)) || "tool";
        const body = part.state === "output-available" ? part.output : part.state === "output-error" ? part.errorText : "";
        lines.push(`**${labels.tool}: ${name}** (\`${part.state ?? ""}\`)`, "");
        if (body !== "" && body !== undefined) {
          lines.push("```json", JSON.stringify(body, null, 2).slice(0, 4000), "```", "");
        }
      }
    }
  }
  return lines.join("\n");
}
