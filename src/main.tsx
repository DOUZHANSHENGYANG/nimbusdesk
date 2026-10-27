import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Providers } from "@/app/providers";
import { i18n, ensureLanguage, readLanguageHint } from "@/lib/i18n";
import { POPUP_LABEL } from "@/features/files/popup";
import "@/index.css";

/**
 * 每个窗口一个 chunk，主应用也是。
 *
 * 以前这 8 个窗口组件 + `App` 全是静态 import —— 于是右键菜单浮窗（一个几十行的菜单）、
 * 文件栅栏、Dock，全都要把主应用、工具箱、AI SDK 一起解析一遍：
 * 单包 3.6 MB，而每个窗口在 Windows 上都是一个独立 WebView2 进程。
 * 现在入口只留 label 分流这一小段，各窗口按需拉自己的组件。
 *
 * `Providers` 保留静态：主题/语言/防白闪显示（`windowReady`）都在它里面，必须先跑起来；
 * 它自己只有轻量的同步逻辑（后台运行时已拆到 `main-runtimes.tsx`，走 lazy）。
 * 主窗口的 `windowReady()` 由 `Providers` → `SettingsSync` 在挂载后调用，而它挂在
 * `App` 里面 —— 所以窗口仍然等 App 就绪后才显示，和拆分前一致，不会白屏闪现。
 */
const App = lazy(() => import("@/app/App"));
const QuickToolsWindow = lazy(() => import("@/features/quick-tools/window").then((m) => ({ default: m.QuickToolsWindow })));
const EdgeHubWindow = lazy(() => import("@/features/desktop/edge-hub").then((m) => ({ default: m.EdgeHubWindow })));
const DockWindow = lazy(() => import("@/features/desktop/dock").then((m) => ({ default: m.DockWindow })));
const FenceWindow = lazy(() => import("@/features/files/fence").then((m) => ({ default: m.FenceWindow })));
const MenuPopupWindow = lazy(() => import("@/features/files/menu-popup").then((m) => ({ default: m.MenuPopupWindow })));
const CaptureWindow = lazy(() => import("@/features/knowledge/capture").then((m) => ({ default: m.CaptureWindow })));
const SearchWindow = lazy(() => import("@/features/search").then((m) => ({ default: m.SearchWindow })));

/**
 * 按窗口 label 分流：fence-* 文件栅栏 /
 * popup-menu 右键菜单浮窗 / main 主应用。
 *
 * 注意各前缀必须互不重叠，且分流要放在 main 兜底之前 ——
 * label 是唯一的路由依据，前缀撞了就会把独立窗口当成主应用渲染
 * （表现为栅栏窗口里出现整个侧栏）。
 */
const windowLabel = (() => {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "main"; // 浏览器 pnpm dev 调试
  }
})();

let root: React.ReactNode;
if (windowLabel.startsWith("edge-hub-")) {
  document.documentElement.classList.add("fence-root");
  root = <Providers><EdgeHubWindow /></Providers>;
} else if (windowLabel === "desktop-dock") {
  document.documentElement.classList.add("fence-root");
  root = <Providers><DockWindow /></Providers>;
} else if (windowLabel === "quick-tools") {
  root = <QuickToolsWindow />;
} else if (windowLabel === "search") {
  root = <SearchWindow />;
} else if (windowLabel === "capture") {
  root = <CaptureWindow />;
} else if (windowLabel === POPUP_LABEL) {
  document.documentElement.classList.add("popup-root");
  root = <MenuPopupWindow />;
} else if (windowLabel.startsWith("fence-")) {
  document.documentElement.classList.add("fence-root");
  root = <FenceWindow categoryId={windowLabel.slice("fence-".length)} />;
} else {
  root = <App />;
}

/*
 * 先把「要用的语言」准备好再渲染。
 *
 * 默认语言（中文）内联在入口，这一步是个已 resolve 的 Promise（只让出一个微任务）；
 * 英文是独立分片，只有语言提示为 en 时才真的去拉。窗口在 `windowReady()` 之前是隐藏的，
 * 而那是 Providers 挂载后的事 —— 所以英文用户不会先看到一闪中文。
 */
const languageHint = readLanguageHint();
void (async () => {
  await ensureLanguage(languageHint);
  if (languageHint === "en") await i18n.changeLanguage("en");
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      {/* 窗口内容懒加载期间的占位：窗口本身在 windowReady() 之前是隐藏的（主窗口）
          或由打开方定位后 show()（菜单/栅栏），这段空白不会闪给用户看。 */}
      <Suspense fallback={null}>{root}</Suspense>
    </React.StrictMode>,
  );
})();
