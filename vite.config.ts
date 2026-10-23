import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

/** 从 rollup 的模块 id 里取出包名（pnpm 的 .pnpm/<pkg>@<ver>/node_modules/<pkg>/ 形式也算对）。 */
function packageOf(id: string): string | undefined {
  const normalized = id.replace(/\\/g, "/");
  const marker = normalized.lastIndexOf("node_modules/");
  if (marker === -1) return undefined;
  const parts = normalized.slice(marker + "node_modules/".length).split("/");
  if (!parts[0]) return undefined;
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

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
  /*
   * 生产构建的分包。
   *
   * 这里**刻意不写 manualChunks**：试过把 react / radix / motion / ai-sdk 强制分组，
   * 结果是 vendor-motion、vendor-radix 反向 import 了 vendor-ai（同一个 chunk 里的
   * 公共 helper），于是 AI SDK 那 416 KB 又被拖回「每个窗口都要加载」的静态闭包里 ——
   * 比不分组还差。真正的收益来自 `main.tsx` 的窗口级 lazy 与 `App.tsx` 的路由级 lazy，
   * 剩下的按引用关系交给 rollup，它自己会把「只有某个懒加载页用得到」的依赖留在那一片里。
   *
   * 只留一条兜底：单块超过 600 KB 时提醒一下 —— 再大就说明又有东西被意外拉进公共路径了。
   */
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        /*
         * 图标单独成一块。
         *
         * rolldown 默认把每个图标模块切成独立 chunk：首屏 72 个请求里五十多个是几 KB 的
         * 图标。桌面端每个请求都要过 WebView2 的 IPC，块太小并不划算 —— lucide 全家
         * 压成一块（几十 KB）比五十个小请求便宜得多。
         *
         * 注意：**不要**用 manualChunks 强制把 react / radix / motion / ai-sdk 分组 ——
         * 试过，vendor-motion、vendor-radix 会反向 import vendor-ai 里的公共 helper，
         * 于是 AI SDK 那 416 KB 又被拖回每个窗口的首屏闭包，比不分组还差。
         */
        codeSplitting: {
          groups: [{ name: "icons", test: /[\\/]node_modules[\\/]lucide-react[\\/]/ }],
        },
      },
    },
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
