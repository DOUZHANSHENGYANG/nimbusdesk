#!/usr/bin/env node
/**
 * 分包回归：在**构建产物**上验证两件事。
 *
 * A. 每个页面只拉自己那一片：
 *    首页不该出现对话页（AI SDK）那一片；`/agent`、`/plans` 各自按需到达且能渲染。
 * B. 每个页面**词表齐全**：走遍所有路由，`window.__i18nMissing` 必须为空。
 *    词表按需加载（工具箱那 100 KB 随页面走）之后，忘了 import 的页面会把 key 原样
 *    画到界面上 —— react-i18next 不缺键报错，所以只能这样断言。
 *
 * 前置：`npm run build && npx vite preview --port 4179 --strictPort`
 * 用法：`npm run check:split`（可用 FIXTURE_ORIGIN 覆盖地址）
 *
 * 说明：普通浏览器里没有 Tauri 运行时，这里桩一个最小 `__TAURI_INTERNALS__`，
 * 让 IPC 一律返回空。因此**桩自身造成的报错**（事件监听解绑、命令返回 null 后
 * 读属性之类）不算失败，只看「chunk 该不该来、页面该不该渲染、词表齐不齐」。
 */
import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const ORIGIN = process.env.FIXTURE_ORIGIN ?? "http://127.0.0.1:4179";
const ROUTES = [
  "/",
  "/projects",
  "/plans",
  "/files",
  "/feeds",
  "/knowledge",
  "/tools",
  "/toolbox/skills",
  "/toolbox/prompts",
  "/toolbox/mcp",
  "/toolbox/harness",
  "/agent",
  "/schedules",
  "/settings",
];

/**
 * 桩的局限造成的报错（不是应用的问题，和分包无关）。
 *
 * 刻意只列**具体两条**，不用「读 null 的 find/length/... 」这种通配 ——
 * 那会把「某页因为桩数据真的崩了」一起吞掉。桩一旦补好，这两条也该删。
 */
const STUB_ARTIFACTS = [
  /unregisterListener/, // 桩没有实现 unlisten 的返回对象
  /transformCallback/, // 桩没有完整的 Channel 实现
];

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });

async function newPage(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const chunks = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/\/assets\/[^/]+\.js$/.test(request.url())) chunks.push(request.url().split("/").pop());
  });
  await page.addInitScript((settings) => {
    const callbacks = new Map();
    let seq = 0;
    // 模拟「运行时没有 View Transitions」：主题切换会走到 GSAP 羽化幕布兜底分支
    if (settings?.disableViewTransition) delete Document.prototype.startViewTransition;
    const respond = (cmd, args) => {
      if (cmd === "plugin:event|listen") return args?.handler ?? null;
      if (cmd.startsWith("plugin:event|")) return null;
      if (cmd === "read_json" && args?.key === "settings" && settings) return settings;
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
  }, options.settings ?? null);
  const realErrors = () => errors.filter((message) => !STUB_ARTIFACTS.some((pattern) => pattern.test(message)));
  /** hash 导航不会重载文档，模块状态会跨路由串味 —— 换查询串 + reload 强制整页重载。 */
  const open = async (hash, { fresh = false } = {}) => {
    const url = fresh ? `${ORIGIN}/?fresh=${Date.now()}#${hash}` : `${ORIGIN}/#${hash}`;
    await page.goto(url, { waitUntil: "networkidle" });
    if (fresh) await page.reload({ waitUntil: "networkidle" });
  };
  return { page, chunks: () => [...new Set(chunks)], realErrors, open };
}

try {
  // ── A1. 首页：只该有入口闭包，不该有对话页那一片 ────────────────────
  const home = await newPage();
  await home.open("/");
  await home.page.getByText("今日计划").first().waitFor({ timeout: 20000 });
  const boot = home.chunks();
  assert.ok(boot.length > 0, "首页应当加载了入口 chunk");
  assert.equal(boot.some((file) => file.startsWith("panel-")), false, "首页不应加载对话页（AI SDK）那一片");
  console.log(`✓ 首页：${boot.length} 块，不含对话页 chunk`);
  await home.page.close();

  // ── A2. 对话页：直接打开时那一片必须出现 ───────────────────────────
  const agent = await newPage();
  await agent.open("/agent");
  await agent.page.waitForTimeout(2500);
  const panelChunks = agent.chunks().filter((file) => file.startsWith("panel-"));
  assert.equal(panelChunks.length > 0, true, "打开 /agent 后应请求到对话页那一片");
  console.log(`✓ 对话页：按需加载 ${panelChunks.join(", ")}`);
  await agent.page.close();

  // ── A3. 计划页：按需到达且能渲染 ──────────────────────────────────
  const plans = await newPage();
  await plans.open("/plans");
  await plans.page.getByText("计划", { exact: false }).first().waitFor({ timeout: 20000 });
  const planChunks = plans.chunks();
  assert.equal(planChunks.length > boot.length, true, "计划页应当比首屏多出至少一个 chunk");
  console.log(`✓ 计划页：新增 ${planChunks.filter((file) => !boot.includes(file)).length} 块并渲染成功`);

  const splitErrors = [...home.realErrors(), ...plans.realErrors()];
  assert.deepEqual(splitErrors, [], "分包改动不应引入运行时错误");

  // ── B. 英文启动：英文词表是分片，真源语言来自 settings（水合后）────────
  const english = await newPage({ settings: { version: 8, state: { theme: "dark", lang: "en" } } });
  await english.open("/");
  await english.page.waitForFunction(
    () => /Home|Today|Overview/.test(document.body.innerText),
    undefined,
    { timeout: 20000 },
  );
  const englishChunks = english.chunks().filter((file) => /^en-/.test(file));
  assert.equal(englishChunks.length, 1, "英文语言应拉取 en-* 分片（且只拉一次）");
  const englishMissing = await english.page.evaluate(() => window.__i18nMissing ?? []);
  assert.deepEqual(englishMissing, [], `英文模式不应缺键：${englishMissing.slice(0, 5).join(", ")}`);
  console.log(`✓ 英文：加载 ${englishChunks.join(", ")}，正文为英文且无缺键`);
  await english.page.close();

  // ── C. 主题切换：gsap 是按需加载的，无 View Transitions 时的兜底路径必须照常工作 ──
  //    断言：主题类翻转、兜底幕布用完被移除、无报错（否则 gsap 分片没加载或 switching 卡住）。
  const themePage = await newPage({ settings: { version: 8, state: { theme: "dark", lang: "zh" } }, disableViewTransition: true });
  await themePage.open("/");
  await themePage.page.getByRole("button", { name: "切换到亮色" }).waitFor({ timeout: 20000 });
  const startedDark = await themePage.page.evaluate(() => document.documentElement.classList.contains("dark"));
  assert.equal(startedDark, true, "初始应为暗色");
  await themePage.page.getByRole("button", { name: "切换到亮色" }).click();
  await themePage.page.waitForFunction(() => !document.documentElement.classList.contains("dark"), undefined, { timeout: 8000 });
  // 兜底幕布（z-index 2147483000）应在动画结束后被移除，说明 gsap 分片到位且收尾干净
  await themePage.page.waitForFunction(
    () => ![...document.body.querySelectorAll("div")].some((node) => node.style.zIndex === "2147483000"),
    undefined,
    { timeout: 8000 },
  );
  assert.deepEqual(themePage.realErrors(), [], "主题切换兜底路径不应报错");
  console.log("✓ 主题：无 View Transitions 时走 gsap 兜底，主题翻转且幕布收尾干净");
  await themePage.page.close();

  // ── B2. 全路由词表完整性（每页强制整页重载）────────────────────────
  const sweep = await newPage();
  const missing = [];
  for (const route of ROUTES) {
    await sweep.open(route, { fresh: true });
    await sweep.page.waitForTimeout(900);
    const absent = await sweep.page.evaluate(() => window.__i18nMissing ?? []);
    if (absent.length) missing.push(`${route}: ${absent.slice(0, 6).join(", ")}`);
    assert.deepEqual(sweep.realErrors(), [], `${route} 不应有运行时错误`);
  }
  assert.deepEqual(missing, [], `这些页面缺词表：\n${missing.join("\n")}`);
  console.log(`✓ 词表：${ROUTES.length} 个路由全部无缺键（词表按需加载没有漏页）`);
  await sweep.page.close();

  console.log("\nPASS 分包：首屏不背对话页，/agent 与 /plans 各自按需到达，全路由词表齐全，无运行时报错");
} finally {
  await browser.close();
}
