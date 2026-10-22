import type { FileUIPart } from "ai";
import type { AgentAttachmentMeta } from "./transcript";

/**
 * 附件的读写与限额。纯函数 + 一次 FileReader，不碰 store，方便单独验。
 *
 * 两种附件的处理方式刻意不同：
 * - **图片**走 AI SDK 的 `file` part（data URL），由服务商自己看；只有当前模型
 *   `vision` 为真才允许。
 * - **文本文件**的内容直接内联进这一轮的消息文本（`<attachment>` 包一段），
 *   因为 OpenAI 兼容接口对 `text/*` 的 file part 支持参差不齐，内联是唯一
 *   处处都认的写法。
 */
export const MAX_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT_BYTES = 256 * 1024;

export interface Pending {
  id: string;
  name: string;
  size: number;
  kind: "image" | "text";
  /** 图片的 data URL / 文本文件的原文。 */
  body: string;
}

const isImage = (file: File) => file.type.startsWith("image/");
const isText = (file: File) =>
  file.type.startsWith("text/") ||
  /\.(md|markdown|txt|json|ya?ml|toml|csv|tsv|log|ts|tsx|js|jsx|css|html?|xml|rs|py|go|java|sql|sh)$/i.test(file.name);

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("AI_ATTACH_UNREADABLE"));
    reader.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("AI_ATTACH_UNREADABLE"));
    reader.readAsText(file);
  });
}

/** 读一个文件；超限、类型不支持、当前模型不支持图片都在这里挡掉。 */
export async function readAttachment(file: File, vision: boolean): Promise<Pending> {
  const base = { id: crypto.randomUUID(), name: file.name || "file", size: file.size };
  if (isImage(file)) {
    if (!vision) throw new Error("AI_ATTACH_NO_VISION");
    if (file.size > MAX_IMAGE_BYTES) throw new Error("AI_ATTACH_TOO_LARGE");
    return { ...base, kind: "image", body: await readAsDataUrl(file) };
  }
  if (isText(file)) {
    if (file.size > MAX_TEXT_BYTES) throw new Error("AI_ATTACH_TOO_LARGE");
    return { ...base, kind: "text", body: await readAsText(file) };
  }
  throw new Error("AI_ATTACH_UNSUPPORTED");
}

export interface BuiltPrompt {
  text: string;
  files: FileUIPart[];
  attachments: AgentAttachmentMeta[];
}

/** 把待发附件拼成 `sendMessage` 要吃的东西。 */
export function buildPrompt(text: string, pending: Pending[]): BuiltPrompt {
  const files: FileUIPart[] = [];
  const attachments: AgentAttachmentMeta[] = [];
  const context: string[] = [];
  for (const item of pending) {
    attachments.push({ name: item.name, kind: item.kind, size: item.size, kept: true });
    if (item.kind === "image") {
      files.push({ type: "file", mediaType: item.body.slice("data:".length).split(";")[0], filename: item.name, url: item.body });
      continue;
    }
    context.push(`<attachment name="${item.name}">\n${item.body}\n</attachment>`);
  }
  return { text: [text, ...context].filter(Boolean).join("\n\n"), files, attachments };
}
