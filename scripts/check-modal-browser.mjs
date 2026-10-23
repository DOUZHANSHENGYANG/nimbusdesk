#!/usr/bin/env node
/**
 * 自建弹窗回归：确认 / 提示 / 输入三种，以及「关着不占分包」这件事。
 *
 * 背景：`ModalProvider` 挂在每个窗口最外层，对话框界面以前一直挂在树上 —— 它是 motion 驱动的
 * （`motion-dom` + `framer-motion` 上百 KB），于是「只显示一张便签」的窗口也要解析整套动画运行时。
 * 现在对话框走 `lazy`，只有真要弹时才加载。这条检查同时盯两头：
 *
 *   1. **关着不挂**：没弹之前 DOM 里不该有 `[role="dialog"]`；
 *   2. **弹得出来、结算得对**：确认弹窗走「取消 → false」「确定 → true」，输入弹窗带回填值，
 *      提示弹窗关掉后 promise 才 resolve。
 *
 * 前置：`npm run dev`（Vite 在 17800）。夹具：`src/components/shell/fixtures/page.html`。
 * 用法：`npm run check:modal`
 */
import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const ORIGIN = process.env.FIXTURE_ORIGIN ?? "http://127.0.0.1:17800";

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const results = () => page.evaluate(() => window.modalReview.results);
const dialog = () => page.getByRole("dialog");

try {
  await page.goto(`${ORIGIN}/src/components/shell/fixtures/page.html`, { waitUntil: "networkidle" });
  await page.locator("#ask-confirm").waitFor({ timeout: 20000 });

  // 1) 关着不挂：对话框分片此时不该在 DOM 里（lazy 挂载）
  assert.equal(await page.locator('[role="dialog"]').count(), 0, "没弹之前不该有对话框节点");
  console.log("✓ 关闭状态：DOM 里没有对话框（按需挂载生效）");

  // 2) 确认弹窗：取消 → false
  await page.locator("#ask-confirm").click();
  await dialog().waitFor();
  assert.match(await dialog().innerText(), /删除这个条目？/);
  assert.match(await dialog().innerText(), /会同时删除磁盘文件。/);
  await dialog().getByRole("button", { name: "取消", exact: true }).click();
  await page.waitForFunction(() => window.modalReview.results.length === 1);
  assert.deepEqual(await results(), [{ kind: "confirm", value: false }]);
  // 退场动画播完（500ms）后节点消失 —— 之后又是一次干净的「关着不挂」
  await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 0, undefined, { timeout: 5000 });
  console.log("✓ 确认弹窗：取消 → 结算 false，退场后节点移除");

  // 3) 确认弹窗：确定 → true
  await page.locator("#ask-confirm").click();
  await dialog().waitFor();
  await dialog().getByRole("button", { name: "删除", exact: true }).click();
  await page.waitForFunction(() => window.modalReview.results.length === 2);
  assert.deepEqual((await results())[1], { kind: "confirm", value: true });
  console.log("✓ 确认弹窗：确定 → 结算 true");

  // 4) 输入弹窗：回填初值，回车提交带回填后的值
  await page.locator("#ask-prompt").click();
  await dialog().waitFor();
  const input = dialog().getByRole("textbox");
  assert.equal(await input.inputValue(), "草稿", "输入框应回填 initial");
  await input.fill("周报");
  await input.press("Enter");
  await page.waitForFunction(() => window.modalReview.results.length === 3);
  assert.deepEqual((await results())[2], { kind: "prompt", value: "周报" });
  console.log("✓ 输入弹窗：回填初值，回车提交带新值");

  // 5) 提示弹窗：只有一个确认按钮，Esc 也能关（dismissible 默认开）
  await page.locator("#ask-alert").click();
  await dialog().waitFor();
  assert.equal(await dialog().getByRole("button", { name: "取消", exact: true }).count(), 0, "提示弹窗不该有取消按钮");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.modalReview.results.length === 4);
  assert.deepEqual((await results())[3], { kind: "alert", value: true });
  console.log("✓ 提示弹窗：无取消按钮，Esc 关闭后结算");

  assert.deepEqual(errors, [], "弹窗流程不应产生运行时错误");
  console.log("\nPASS 弹窗：按需挂载、三种类型都能弹能结算、退场后不留节点、无运行时报错");
} finally {
  await browser.close();
}
