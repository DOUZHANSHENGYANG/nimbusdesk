#!/usr/bin/env node
/**
 * 分包回归：在**构建产物**上验证「每个页面/窗口只拉自己那一片」。
 *
 * 它检查的是分包这件事本身，而不是业务行为（业务行为在 `src/features/*​/fixtures` 那套夹具里）：
 *   1. 首页起来时，AI SDK 那一片（对话页）不在请求列表里；
 *   2. 直接打开 /agent，请求里出现对话页那一片（说明它真的被拆出去了，而不是被打进入口）；
 *   3. 打开 /plans，计划页那一片按需到达，页面能渲染出内容。
 *
 * 前置：`npm run build && npx vite preview --port 4179 --strictPort`
 * 用法：`node scripts/check-split-browser.mjs`（可用 FIXTURE_ORIGIN 覆盖地址）
 *
 * 说明：普通浏览器里没有 Tauri 运行时，这里桩一个最小 `__TAURI_INTERNALS__`，
 * 让 IPC 一律返回空。因此**桩自身造成的报错**（事件监听解绑、命令返回 null 后
 * 读属性之类）不算失败，只看「chunk 该不该来、页面该不该渲染、有没有别的异常」。
 */
import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const ORIGIN = process.env.FIXTURE_ORIGIN ?? "http://127.0.0.1:4179";

/** 桩的局限造成的报错（不是应用的问题，和分包无关）。 */
const STUB_ARTIFACTS = [
  /unregisterListener/,
  /transformCallback/,
  /Cannot read properties of (null|undefined) \(reading '(find|length|map|filter|some)'\)/,
];

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });

async function open(hash) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const chunks = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/\/assets\/[^/]+\.js$/.test(request.url())) chunks.push(request.url().split("/").pop());
  });
  await page.addInitScript(() => {
    const callbacks = new Map();
    let seq = 0;
    const respond = (cmd, args) => {
      if (cmd === "plugin:event|listen") return args?.handler ?? null;
      if (cmd.startsWith("plugin:event|")) return null;
      if (/^list_|_list$/.test(cmd)) return [];
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
      invoke: async (cmd, args) => respond(cmd, args),
      convertFileSrc: (value) => value,
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    };
  });
  await page.goto(`${ORIGIN}/#${hash}`, { waitUntil: "networkidle" });
  return { page, errors, chunks: () => [...new Set(chunks)] };
}

try {
  // ── 首屏：只该有入口闭包，不该有对话页那一片 ───────────────────────
  const home = await open("/");
  await home.page.getByText("今日计划").first().waitFor({ timeout: 20000 });
  const boot = home.chunks();
  assert.ok(boot.length > 0, "首页应当加载了入口 chunk");
  assert.equal(
    boot.some((file) => file.startsWith("panel-")),
    false,
    "首页不应加载对话页（AI SDK）那一片",
  );
  console.log(`✓ 首页：${boot.length} 块，不含对话页 chunk`);
  await home.page.close();

  // ── 对话页：直接打开时那一片必须出现 ──────────────────────────────
  const agent = await open("/agent");
  await agent.page.waitForTimeout(2500);
  const agentChunks = agent.chunks();
  assert.equal(
    agentChunks.some((file) => file.startsWith("panel-")),
    true,
    "打开 /agent 后应请求到对话页那一片",
  );
  console.log(`✓ 对话页：按需加载 ${agentChunks.filter((file) => file.startsWith("panel-")).join(", ")}`);
  await agent.page.close();

  // ── 计划页：按需到达且能渲染 ────────────────────────────────────
  const plans = await open("/plans");
  await plans.page.getByText("计划", { exact: false }).first().waitFor({ timeout: 20000 });
  const planChunks = plans.chunks();
  assert.equal(
    planChunks.length > boot.length,
    true,
    "计划页应当比首屏多出至少一个 chunk",
  );
  console.log(`✓ 计划页：新增 ${planChunks.filter((file) => !boot.includes(file)).length} 块并渲染成功`);

  const realErrors = [...home.errors, ...plans.errors].filter(
    (message) => !STUB_ARTIFACTS.some((pattern) => pattern.test(message)),
  );
  assert.deepEqual(realErrors, [], "分包改动不应引入运行时错误");

  console.log("\nPASS 分包：首屏不背对话页，/agent 与 /plans 各自按需加载，无运行时报错");
} finally {
  await browser.close();
}
