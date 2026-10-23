#!/usr/bin/env node
/**
 * 前台门控回归：窗口不可见时，周期性 IPC 轮询必须停下来；切回前台要立刻补一次。
 *
 * 用「设置 → 搜索」那个 3 秒轮询 `search_status` 作为观察点（它是最典型的纯刷新轮询）。
 *
 * 前置：`npm run build && npx vite preview --port 4179 --strictPort`
 * 用法：`npm run check:visibility`
 *
 * 断言：
 *   1. 可见时 `search_status` 会周期性出现；
 *   2. 把文档标成 hidden 之后，4 秒内不再新增；
 *   3. 恢复 visible 后立刻补一拍（不用等下一个 3 秒）。
 */
import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const ORIGIN = process.env.FIXTURE_ORIGIN ?? "http://127.0.0.1:4179";

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

await page.addInitScript(() => {
  const callbacks = new Map();
  const calls = [];
  let seq = 0;
  const respond = (cmd, args) => {
    if (cmd === "plugin:event|listen") return args?.handler ?? null;
    if (cmd.startsWith("plugin:event|")) return null;
    if (/^list_|_list$/.test(cmd)) return [];
    if (cmd === "search_status") return { count: 0, indexing: false, backend: "windows", everythingAvailable: false, files: { running: false, paused: false, total: 0, processed: 0, indexed: 0, failed: 0 } };
    if (cmd === "search_apps_status") return { count: 0, indexing: false, apps: [] };
    if (cmd === "search_document_defaults") return [];
    if (cmd === "get_data_dir") return "C:/Users/dz/AppData/Roaming/nimbusdesk";
    return null;
  };
  window.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => {
      seq += 1;
      callbacks.set(seq, cb);
      return seq;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    invoke: async (cmd, args) => {
      calls.push(cmd);
      return respond(cmd, args);
    },
    convertFileSrc: (value) => value,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
  };
  window.__calls = calls;
  /** 模拟「窗口被最小化/完全遮住」 */
  window.__setVisibility = (state) => {
    Object.defineProperty(document, "visibilityState", { get: () => state, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  };
});

const pollCount = () => page.evaluate(() => window.__calls.filter((cmd) => cmd === "search_status").length);

try {
  await page.goto(`${ORIGIN}/#/settings`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^搜索/ }).click();
  await page.getByText("搜索").first().waitFor({ timeout: 15000 });

  // 1) 可见时确实在轮询
  const before = await pollCount();
  await page.waitForTimeout(3600);
  const visible = await pollCount();
  assert.ok(visible > before, `可见时应周期性轮询 search_status（${before} → ${visible}）`);
  console.log(`✓ 可见：3.6 秒内轮询 ${visible - before} 次 search_status`);

  // 2) 隐藏后停手
  await page.evaluate(() => window.__setVisibility("hidden"));
  const hiddenStart = await pollCount();
  await page.waitForTimeout(4200);
  const hiddenEnd = await pollCount();
  assert.equal(hiddenEnd, hiddenStart, `隐藏后不应再轮询（多了 ${hiddenEnd - hiddenStart} 次）`);
  console.log("✓ 隐藏：4.2 秒静默，一次也没轮询");

  // 3) 回到前台立刻补一拍
  await page.evaluate(() => window.__setVisibility("visible"));
  await page.waitForTimeout(600);
  const resumed = await pollCount();
  assert.ok(resumed > hiddenEnd, "回到前台应立即补一拍，而不是等下一个周期");
  console.log(`✓ 回前台：600 毫秒内补了 ${resumed - hiddenEnd} 拍`);

  const real = errors.filter((message) => !/unregisterListener|transformCallback|Cannot read properties of (null|undefined)/.test(message));
  assert.deepEqual(real, [], "不应有运行时错误");
  console.log("\nPASS 前台门控：不可见时轮询停下，回到前台立刻补一拍");
} finally {
  await browser.close();
}
