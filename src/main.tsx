import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "@/app/App";
import { FenceWindow } from "@/features/files/fence";
import "@/index.css";

/** 按窗口 label 分流：fence-* 桌面栅栏 / main 主应用（设置为主窗口内路由） */
const windowLabel = (() => {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "main"; // 浏览器 pnpm dev 调试
  }
})();

let root: React.ReactNode;
if (windowLabel.startsWith("fence-")) {
  document.documentElement.classList.add("fence-root");
  root = <FenceWindow categoryId={windowLabel.slice("fence-".length)} />;
} else {
  root = <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{root}</React.StrictMode>,
);
