import type { ChatMessage } from "../ai/core.ts";
import { requestStructuredReply } from "../knowledge/structured-response.ts";
import { buildMessages, parseToolReply, replySchema, type ToolId, type ToolOptions, type ToolReply } from "./core.ts";
import { checkSyntax, semanticChange, type SyntaxCheck } from "./syntax.ts";

export class StaleToolRequest extends Error {}
export interface ToolResult extends ToolReply { source: string; check: SyntaxCheck; semanticsChanged: boolean | null }

export async function runTool(tool: ToolId, source: string, options: ToolOptions, lang: "zh" | "en", request: (messages: ChatMessage[]) => Promise<string>, current = () => true): Promise<ToolResult> {
  const assertCurrent = () => { if (!current()) throw new StaleToolRequest(); };
  const reply = await requestStructuredReply({
    messages: buildMessages(tool, source, options, lang), schema: replySchema(tool),
    request: async (messages) => {
      assertCurrent();
      // Preserve task + material on retries even with last-user-message gateways.
      const input: ChatMessage[] = messages.length > 2 ? [messages[0], { role: "user", content: messages.slice(1).map((message) => message.content).join("\n\n") }] : messages;
      const answer = await request(input);
      assertCurrent();
      return answer;
    },
    parse: (answer) => parseToolReply(tool, answer, options),
  });
  assertCurrent();
  // Explanation mode must never silently replace the user's source.
  const text = tool === "format" && options.mode === "explain" ? source : reply.text;
  return { ...reply, text, source, check: tool === "format" ? checkSyntax(options.format, text) : { status: "unverified", message: "" }, semanticsChanged: tool === "format" ? semanticChange(options.format, source, text) : null };
}
