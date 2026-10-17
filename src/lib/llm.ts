/** News uses the same native provider and credential path as knowledge tools. */
import { chatWithProvider } from "@/features/ai/client";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Preserve the news callback contract; the shared native client returns one answer. */
export async function chatStream(
  messages: ChatMessage[],
  onDelta?: (chunk: string) => void,
): Promise<string> {
  const full = await chatWithProvider(messages);
  onDelta?.(full);
  return full;
}
