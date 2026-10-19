import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** 按环境变量 → 常见安装位置 → PATH 的顺序找一个可用的 Chromium。 */
export function resolveBrowser() {
  if (process.env.PLAYWRIGHT_BROWSER) return process.env.PLAYWRIGHT_BROWSER;
  const candidates = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const path of candidates) if (existsSync(path)) return path;
  for (const name of ["msedge", "google-chrome", "chromium"]) {
    try {
      const found = execFileSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" }).split(/\r?\n/)[0];
      if (found && existsSync(found)) return found;
    } catch {
      // 没装就继续找下一个
    }
  }
  throw new Error("找不到可用的浏览器。设置 PLAYWRIGHT_BROWSER 指向 msedge 或 chrome 可执行文件。");
}

/** 找到一个本机已安装的 playwright 入口，不下载任何东西。 */
export async function loadPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  const errors = [];
  // 先试常规模块解析，覆盖 `pnpm add -D playwright` 和 npx 缓存。
  for (const specifier of ["playwright", "@playwright/test", "playwright-core"]) {
    try {
      return await import(specifier);
    } catch (error) {
      errors.push(`${specifier}: ${error.message}`);
    }
  }
  throw new Error(
    "找不到 playwright。安装它（pnpm add -D playwright），或用 PLAYWRIGHT_MODULE 指向 index.mjs。\n" + errors.join("\n"),
  );
}
