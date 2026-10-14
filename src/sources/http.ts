/**
 * 统一网络层。不变量：所有外部请求只经这里。
 * - Tauri 内：走 tauri-plugin-http（Rust 原生代理，绕过 WebView CORS）
 * - 非 Tauri（浏览器 dev / node 脚本）：退回全局 fetch，方便本地调试适配器
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function rawFetch(url: string, init?: RequestInit): Promise<Response> {
  if (inTauri()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(url, init);
  }
  return globalThis.fetch(url, init);
}

export async function httpText(url: string, init?: RequestInit): Promise<string> {
  const res = await rawFetch(url, {
    ...init,
    headers: { "User-Agent": UA, ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export async function httpJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  return JSON.parse(await httpText(url, init)) as T;
}
