import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname ?? ".", "./src"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  /*
   * 把「按需动态 import」的依赖提前钉进预打包。
   *
   * `src/sources/http.ts` 里 `await import("@tauri-apps/plugin-http")` 是懒加载：
   * 如果 vite 在会话中途才发现它（discovery），会重新预打包整份 deps、
   * 换掉全部 `?v=` 哈希 —— 已经加载过的窗口攥着旧地址，懒加载就 404，
   * 报「Failed to fetch dynamically imported module」。WebView2 的 HTTP 缓存
   * 还会让这个旧地址跨进程存活，重启应用都不消失。
   *
   * 列在这里 = 启动时就打包好，会话中途哈希不再变。
   */
  optimizeDeps: {
    include: [
      "@tauri-apps/plugin-http",
      "@tauri-apps/plugin-dialog",
      "@tauri-apps/plugin-notification",
      "@tauri-apps/plugin-opener",
      "@tauri-apps/plugin-clipboard-manager",
    ],
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    // 强制 IPv4：WebView2 对 localhost 的 ::1/127.0.0.1 解析不确定，固定 127.0.0.1 最稳
    host: host || "127.0.0.1",
    port: 17800,
    strictPort: true,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 17801,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
