import type { OrganizeSuggestion, CaptureRecord, ReadNote } from "./types";
import { parseJsonObject, readSuggestedTags, StructuredReplyError } from "./structured-response.ts";

/** Attachment labels are useful context even when the user does not send image pixels. */
export function organizationMaterialText(materials: { capture: Pick<CaptureRecord, "id" | "title" | "project" | "source" | "attachments">; note: Pick<ReadNote, "content"> }[]): string {
  return materials.map(({ capture, note }) => `MATERIAL ${capture.id}\nTitle: ${capture.title}\nProject: ${capture.project}\nSource: ${capture.source}\nAttachments: ${JSON.stringify(capture.attachments.map(({ name, path, mime }) => ({ name, path, mime })))}\nContent:\n${note.content}`).join("\n\n---\n\n");
}

/** Keep the extension truthful while allowing descriptive names with dots. */
export function ensureImageExtension(name: string, mime: string): string {
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[mime];
  if (!extension) throw new Error("Unsupported image type");
  const stem = name.trim().replace(/\.(png|jpe?g|webp|gif)$/i, "").trim() || "截图";
  return `${stem}.${extension}`;
}

/** AI responses are data. Only predefined kinds can reach the native archive command. */
export function parseOrganizeSuggestion(answer: string): OrganizeSuggestion {
  const item = parseJsonObject(answer);
  if (typeof item.title !== "string" || !item.title.trim() || item.title.length > 300 || typeof item.content !== "string" || !item.content.trim() || item.content.length > 500_000 || typeof item.kind !== "string" || !["experience", "recipe", "resource"].includes(item.kind)) throw new StructuredReplyError();
  return { title: item.title.trim(), kind: item.kind as OrganizeSuggestion["kind"], content: item.content, tags: readSuggestedTags(item.tags) };
}
