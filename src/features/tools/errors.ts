import type { ToolsCopy } from "./copy";
export function toolErrorMessage(error: unknown, c: ToolsCopy): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("AI_NO_PROVIDER")) return c.unconfigured;
  if (/AI_HTTP_(401|403)/.test(message)) return c.auth;
  if (message.includes("AI_NETWORK")) return c.network;
  if (message.includes("AI_DESKTOP_REQUIRED")) return c.desktop;
  if (message.includes("TOOLS_TOO_LARGE")) return c.tooLarge;
  if (message.includes("TOOLS_EMPTY")) return c.empty;
  if (error instanceof Error && error.name === "StructuredReplyError") return c.structured;
  return c.failed;
}
