import { Channel, invoke } from "@tauri-apps/api/core";
import { inTauri } from "@/lib/tauri";

/** Rust 侧 `FetchEvent`（camelCase + `kind` 标签），见 `commands/ai.rs`。 */
export type FetchEvent =
  | { kind: "head"; status: number; headers: [string, string][] }
  | { kind: "chunk"; text: string }
  | { kind: "end" }
  | { kind: "err"; message: string };

/**
 * 读空闲看门狗。Rust 侧刻意不设整请求 timeout（那会连读 body 一起管、长流会被
 * 拦腰砍断），所以「多久没动静算断线」由前端决定。
 */
const IDLE_TIMEOUT_MS = 90_000;

/**
 * 把 `ai_fetch` 包成一个普通的 `fetch`：**唯一**知道「请求要经 Rust」的地方。
 *
 * 密钥只在 Rust 侧，WebView 直连又过不了 CORS，所以带密钥的转发必须走 IPC；
 * AI SDK 的 provider 与工具循环只看得到一个 `fetch`。
 * 浏览器 dev 下退化为原生 fetch（没有密钥，一定 401），方便只调 UI。
 */
export function agentFetch(providerId: string, baseUrl: string): typeof fetch {
  if (!inTauri) return fetch;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const channel = new Channel<FetchEvent>();
    const encoder = new TextEncoder();
    let resolveHead!: (head: Extract<FetchEvent, { kind: "head" }>) => void;
    let rejectHead!: (error: unknown) => void;
    const head = new Promise<Extract<FetchEvent, { kind: "head" }>>((resolve, reject) => {
      resolveHead = resolve;
      rejectHead = reject;
    });
    let settled = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let fail: ((error: unknown) => void) | undefined;
    const stopIdle = () => { clearTimeout(idle); idle = undefined; };
    const stream: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
      start(controller) {
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          stopIdle();
          if (error === undefined) controller.close();
          else controller.error(error);
        };
        fail = finish;
        const arm = () => {
          stopIdle();
          idle = setTimeout(() => {
            // 取消在下一个 chunk 到达时才在 Rust 侧生效，所以这里先把流判死。
            void invoke("ai_fetch_cancel", { providerId }).catch(() => undefined);
            finish(new Error("AI_STREAM_TIMEOUT"));
          }, IDLE_TIMEOUT_MS);
        };
        channel.onmessage = (event) => {
          if (event.kind === "head") {
            arm();
            resolveHead(event);
            return;
          }
          if (event.kind === "chunk") {
            arm();
            controller.enqueue(encoder.encode(event.text));
            return;
          }
          if (event.kind === "err") {
            const error = new Error(event.message);
            rejectHead(error);
            finish(error);
            return;
          }
          finish();
        };
      },
      cancel() {
        settled = true;
        stopIdle();
        void invoke("ai_fetch_cancel", { providerId }).catch(() => undefined);
      },
    });
    const job = invoke("ai_fetch", {
      input: {
        providerId,
        baseUrl,
        url: String(input),
        method: (init?.method ?? "GET").toUpperCase(),
        headers: [...new Headers(init?.headers).entries()],
        // AI SDK 发的永远是 JSON 字符串；其余形状（流、FormData）不支持。
        body: typeof init?.body === "string" ? init.body : null,
      },
      onEvent: channel,
    });
    void job.catch((error) => {
      // 校验类错误（AI_INVALID_URL / AI_ORIGIN_MISMATCH …）在流开始前就返回，
      // 此时只 reject 头部，否则 await head 会一直挂着。
      rejectHead(error);
      fail?.(error instanceof Error ? error : new Error(String(error)));
    });
    const resolved = await head;
    return new Response(stream, { status: resolved.status, headers: resolved.headers });
  };
}
