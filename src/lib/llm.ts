/** OpenAI 兼容 LLM 客户端（SSE 流式），端点/Key/模型来自设置 */
import { rawFetch } from "@/sources/http";
import { useAiSettings } from "@/stores/ai";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chatStream(
  messages: ChatMessage[],
  onDelta?: (chunk: string) => void,
): Promise<string> {
  const { llmBaseUrl, llmApiKey, llmModel } = useAiSettings.getState();
  if (!llmBaseUrl || !llmApiKey) throw new Error("LLM 未配置：请在设置里填写端点与 Key");

  const res = await rawFetch(`${llmBaseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${llmApiKey}` },
    body: JSON.stringify({ model: llmModel, messages, stream: true }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  let full = "";
  const reader = res.body?.getReader?.();

  // 无流式 body → 整体解析
  if (!reader) {
    const data = await res.json();
    full = data?.choices?.[0]?.message?.content ?? "";
    onDelta?.(full);
    return full;
  }

  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta?.(delta);
        }
      } catch {
        /* 半行 JSON 忽略 */
      }
    }
  }
  return full;
}
