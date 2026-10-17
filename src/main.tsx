import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { QuickToolsWindow } from "@/features/quick-tools/window";
import { EdgeHubWindow } from "@/features/desktop/edge-hub";
import { Providers } from "@/app/providers";
import App from "@/app/App";
import { FenceWindow } from "@/features/files/fence";
import { MenuPopupWindow } from "@/features/files/menu-popup";
import { TodoPaperWindow } from "@/features/plans/views/paper";
import { POPUP_LABEL } from "@/features/files/popup";
import { CaptureWindow } from "@/features/knowledge/capture";
import { SearchWindow } from "@/features/search";
import "@/index.css";

/**
 * 按窗口 label 分流：fence-* 文件栅栏 / todo-* 待办纸片 /
 * popup-menu 右键菜单浮窗 / main 主应用。
 *
 * 注意 todo- 的匹配必须放在 main 兜底之前，且前缀不与 fence- 重叠 ——
 * label 是唯一的路由依据，前缀撞了就会把纸片当成主应用渲染
 * （表现为纸片窗口里出现整个侧栏）。
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
} else if (windowLabel.startsWith("todo-")) {
  document.documentElement.classList.add("fence-root");
  root = <TodoPaperWindow date={windowLabel.slice("todo-".length)} />;
} else {
  root = <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{root}</React.StrictMode>,
);
