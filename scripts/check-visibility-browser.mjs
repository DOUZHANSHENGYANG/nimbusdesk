#!/usr/bin/env node
/**
 * 前台门控回归：看的是真实轮询面——GitHub 页用 startForegroundInterval 每 5 分钟对齐一次。
 *
 * 前置：`npm run dev`（Vite 在 17800），夹具 src/features/projects/fixtures/github.html
 *       （?hold=1 把网络挂住，由测试端放行；githubReview.setVisibility 改真实 document.visibilityState）。
 * 用法：`node scripts/check-visibility-browser.mjs`
 *
 * 断言：
 *   1. 放行后首屏同步真的发出请求；
 *   2. 窗口不可见时不再发起轮询；
 *   3. 回到前台立刻补一拍（catch-up），不用等满一个间隔。
 */
import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const ORIGIN = process.env.FIXTURE_ORIGIN ?? "http://127.0.0.1:17800";
const FIXTURE = `${ORIGIN}/src/features/projects/fixtures/github.html`;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const requests = () => page.evaluate(() => window.githubReview.http.length);

try {
  await page.goto(`${FIXTURE}?hold=1`, { waitUntil: "domcontentloaded" });
  // 首屏同步被闸门挂住：等到真的挂上了一批请求
  await page.waitForFunction(() => window.githubReview.held.length > 0, undefined, { timeout: 20000 });
  const held = await requests();
  assert.ok(held > 0, "首屏同步应当已经发出请求（被闸门挂住）");

  await page.evaluate(() => window.githubReview.releaseAll());
  await page.locator("[data-github-repo]").first().waitFor({ timeout: 15000 });
  const loaded = await requests();
  assert.ok(loaded >= held, "放行后应当完成首屏同步");

  // 不可见：不应再发起轮询
  await page.evaluate(() => window.githubReview.setVisibility("hidden"));
  await page.waitForTimeout(1500);
  const hidden = await requests();
  assert.equal(hidden, loaded, `窗口不可见时不该再轮询（多发了 ${hidden - loaded} 次）`);
  console.log(`✓ 不可见 1.5 秒静默（停在 ${hidden} 次请求）`);

  // 回到前台：立刻补一拍
  await page.evaluate(() => window.githubReview.setVisibility("visible"));
  await page.waitForFunction((base) => window.githubReview.http.length > base, loaded, { timeout: 8000 });
  console.log("✓ 回到前台立刻补了一拍（不必等满间隔）");

  assert.deepEqual(errors, []);
  console.log("PASS 前台门控：不可见不轮询，回前台即补拍（GitHub 页真实轮询面）");
} finally {
  await browser.close();
}
