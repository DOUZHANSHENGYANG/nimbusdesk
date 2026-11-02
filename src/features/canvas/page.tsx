import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, ArrowLeft, LoaderCircle, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { invoke, Channel } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { useProviders, providersReady } from "@/features/ai/providers";
import { listModelOptions } from "@/features/agent/model";
import { inTauri } from "@/lib/tauri";

/**
 * ThoughtDAG 画布（内置版）。
 *
 * dist 已随前端资源打包在 `/thoughtdag/`，由云台自己的 WebView 直接加载，
 * 不需要用户下载源码、安装 Node 或启动额外进程。模型与对话由注入的
 * `__nimbus_bridge.js` 转发回云台。
 */
const CANVAS_URL = "/thoughtdag/index.html?su=1";

/** 把 OpenAI 兼容接口的错误体转成一句能直接展示的话。 */
function describeHttpError(status: number, body: string): string {
  const raw = body.trim();
  if (!raw) return `AI 调用失败（HTTP ${status}）`;
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string } | string;
      message?: string;
    };
    const message =
      typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
    if (message) return `AI 调用失败（HTTP ${status}）：${message}`;
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return `AI 调用失败（HTTP ${status}）：${raw.slice(0, 300)}`;
}

export function CanvasPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const frame = useRef<HTMLIFrameElement>(null);
  const [frameState, setFrameState] = useState<"loading" | "ready" | "error">("loading");
  const [frameKey, setFrameKey] = useState(0);
  useEffect(() => {
    setFrameState("loading");
    // shortcut: onLoad 只说明文档加载完，内层导航失败它看不到，只能超时兜底
    const timer = window.setTimeout(() => setFrameState(current => current === "loading" ? "error" : current), 8000);
    return () => window.clearTimeout(timer);
  }, [frameKey]);

  const reload = useCallback(() => {
    if (frame.current) frame.current.src = `${CANVAS_URL}&t=${Date.now()}`;
  }, []);

  // ThoughtDAG 页面里的 window.desktop 桥把文件原语发到这里，由云台用 Tauri 命令读写。
  useEffect(() => {
    if (!inTauri) return;
    const handler = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.__nimbus !== true || typeof data.id !== "string") return;
      const args = data.args ?? {};
      let ok = true;
      let payload: unknown = null;
      let error = "";
      try {
        switch (data.method) {
          case "sessions.roots":
            payload = await invoke("canvas_session_roots");
            break;
          case "sessions.list":
            payload = await invoke("canvas_session_list", { rootKey: args.rootKey });
            break;
          case "sessions.read":
            payload = await invoke("canvas_session_read", { rootKey: args.rootKey, rel: args.rel });
            break;
          case "sessions.head":
            payload = await invoke("canvas_session_head", { rootKey: args.rootKey, rel: args.rel, bytes: args.bytes });
            break;
          case "sessions.readRange":
            payload = await invoke("canvas_session_read_range", {
              rootKey: args.rootKey,
              rel: args.rel,
              start: args.start,
              length: args.length,
            });
            break;
          case "models.list": {
            await providersReady();
            const options = listModelOptions(useProviders.getState());
            payload = {
              models: options.map((option) => ({
                id: `${option.providerId}/${option.modelId}`,
                name: option.modelId,
                provider: option.providerName,
                vision: option.vision,
              })),
              default: options[0] ? `${options[0].providerId}/${options[0].modelId}` : null,
              capabilities: { webSearch: false, vision: options.some((option) => option.vision) },
            };
            break;
          }
          case "chat.stream": {
            const source = event.source as WindowProxy | null;
            const send = (payload: Record<string, unknown>) =>
              source?.postMessage({ __nimbusStream: true, id: data.id, ...payload }, event.origin);
            let finished = false;
            try {
              await providersReady();
              const model = String(args.model ?? "");
              const slash = model.indexOf("/");
              const providerId = slash >= 0 ? model.slice(0, slash) : "";
              const modelId = slash >= 0 ? model.slice(slash + 1) : model;
              const provider = useProviders.getState().providers.find((item) => item.id === providerId);
              if (!provider) throw new Error(`没有找到云台提供商 ${providerId}`);
              const channel = new Channel<{ kind: string; text?: string; status?: number; message?: string }>();
              let status = 0;
              let errorBody = "";
              let sawText = false;
              channel.onmessage = (message) => {
                if (message.kind === "head") {
                  status = message.status ?? 0;
                  return;
                }
                if (message.kind === "chunk" && message.text) {
                  const chunk = message.text;
                  // 4xx/5xx 的错误体不是 SSE，先攒起来做可读报错。
                  if (!chunk.trimStart().startsWith("data: ")) {
                    if (status >= 400) errorBody += chunk;
                    return;
                  }
                  for (const line of chunk.split(/\r?\n/)) {
                    if (!line.startsWith("data: ")) continue;
                    const payload = line.slice(6);
                    if (payload === "[DONE]") continue;
                    try {
                      const parsed = JSON.parse(payload) as {
                        choices?: Array<{ delta?: { content?: string } }>;
                        error?: { message?: string };
                      };
                      if (parsed.error?.message) {
                        send({ error: parsed.error.message });
                        finished = true;
                      }
                      const text = parsed.choices?.[0]?.delta?.content;
                      if (text) {
                        sawText = true;
                        send({ text });
                      }
                    } catch {
                      // Keep provider-specific SSE events out of the text stream.
                    }
                  }
                } else if (message.kind === "err") {
                  const reason =
                    message.message === "AI_NETWORK_ERROR"
                      ? "无法连接 AI 服务（网络错误）"
                      : message.message || "AI 流式请求失败";
                  send({ error: reason });
                  finished = true;
                }
              };
              await invoke("ai_fetch", {
                input: {
                  providerId: provider.id,
                  baseUrl: provider.baseUrl,
                  url: `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`,
                  method: "POST",
                  headers: [["Content-Type", "application/json"]],
                  body: JSON.stringify({ model: modelId, messages: args.messages ?? [], stream: true }),
                },
                onEvent: channel,
              });
              if (!finished && status >= 400 && !sawText) {
                const canFallback = status >= 500 && provider.model && provider.model !== modelId;
                if (!canFallback) throw new Error(describeHttpError(status, errorBody));
                try {
                  const text = await invoke<string>("ai_chat", {
                    input: {
                      provider: {
                        id: provider.id,
                        baseUrl: provider.baseUrl,
                        model: provider.model,
                        vision: provider.vision,
                        parameters: {},
                      },
                      messages: args.messages ?? [],
                      useStoredKey: true,
                    },
                  });
                  send({ text });
                } catch (fallback) {
                  throw new Error(
                    `${describeHttpError(status, errorBody)}；默认模型 ${provider.model} 也失败: ${
                      fallback instanceof Error ? fallback.message : String(fallback)
                    }`,
                  );
                }
              }
            } catch (cause) {
              send({ error: cause instanceof Error ? cause.message : String(cause) });
              finished = true;
            }
            if (!finished) send({ done: true });
            break;
          }
          case "chat.complete": {
            await providersReady();
            const model = String(args.model ?? "");
            const slash = model.indexOf("/");
            const providerId = slash >= 0 ? model.slice(0, slash) : "";
            const modelId = slash >= 0 ? model.slice(slash + 1) : model;
            const provider = useProviders.getState().providers.find((item) => item.id === providerId);
            if (!provider) throw new Error(`没有找到云台提供商 ${providerId}`);
            const option = listModelOptions({
              ...useProviders.getState(),
              providers: [provider],
            }).find((item) => item.modelId === modelId);
            const request = (id: string) =>
              invoke<string>("ai_chat", {
                input: {
                  provider: {
                    id: provider.id,
                    baseUrl: provider.baseUrl,
                    model: id,
                    vision: option?.vision ?? provider.vision,
                    parameters: option?.parameters ?? {},
                  },
                  messages: args.messages ?? [],
                  useStoredKey: true,
                },
              });
            try {
              payload = await request(modelId);
            } catch (cause) {
              // A provider can expose several models where one account is
              // cooling down (HTTP 503). Retry with the provider's default
              // model before surfacing the failure to ThoughtDAG.
              if (provider.model && provider.model !== modelId) {
                try {
                  payload = await request(provider.model);
                } catch (fallbackCause) {
                  throw new Error(
                    `${cause instanceof Error ? cause.message : String(cause)}；默认模型 ${provider.model} 也失败: ${
                      fallbackCause instanceof Error ? fallbackCause.message : String(fallbackCause)
                    }`,
                  );
                }
              } else {
                throw cause;
              }
            }
            break;
          }
          default:
            payload = null;
        }
      } catch (cause) {
        ok = false;
        error = cause instanceof Error ? cause.message : String(cause);
      }
      (event.source as WindowProxy | null)?.postMessage(
        { __nimbusResult: true, id: data.id, ok, data: payload, error },
        event.origin,
      );
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const openInBrowser = useCallback(async () => {
    try {
      await invoke("canvas_open_window");
    } catch {
      const url = new URL(CANVAS_URL, window.location.href).toString();
      await openUrl(url);
    }
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-5">
      <header className="relative z-10 flex shrink-0 flex-wrap items-start justify-between gap-3">
        <h1 className="sr-only">{t("canvas.title")}</h1>
        {/* 侧栏入口已撤：画布现在从 AI 对话进，所以这里必须有一条回得去的路 */}
        <Button variant="ghost" size="sm" onClick={() => navigate("/ai/agent")}>
          <ArrowLeft />
          {t("canvas.backToChat")}
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("canvas.builtin")}</span>
          <Button variant="outline" size="sm" onClick={() => { reload(); setFrameKey(value => value + 1); }}>
            <RefreshCw />
            {t("canvas.reload")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void openInBrowser()}>
            <ExternalLink />
            {t("canvas.open")}
          </Button>
        </div>
      </header>

      <div className="relative z-0 min-h-[320px] flex-1 overflow-hidden rounded-xl border border-border bg-card" aria-busy={frameState === "loading"}>
        <iframe
          key={frameKey}
          ref={frame}
          title="ThoughtDAG"
          src={CANVAS_URL}
          onLoad={() => setFrameState("ready")}
          className={frameState === "error" ? "size-full opacity-0" : "size-full"}
          allow="clipboard-read; clipboard-write"
        />
        {frameState === "loading" && <div className="pointer-events-none absolute inset-0 grid place-items-center gap-2 bg-background/80 text-xs text-muted-foreground">
          <span className="flex items-center gap-2"><LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />{t("canvas.loading")}</span>
        </div>}
        {frameState === "error" && <div role="alert" className="absolute inset-0 grid place-items-center bg-background p-6 text-center">
          <div className="max-w-sm space-y-3">
            <p className="text-sm font-medium">{t("canvas.loadFailed")}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("canvas.loadFailedHint")}</p>
            <div className="flex justify-center gap-2">
              <Button size="sm" variant="outline" onClick={() => { setFrameKey(value => value + 1); }}><RefreshCw />{t("canvas.reload")}</Button>
              <Button size="sm" variant="ghost" onClick={() => void openInBrowser()}>{t("canvas.open")}</Button>
            </div>
          </div>
        </div>}
      </div>
    </div>
  );
}
