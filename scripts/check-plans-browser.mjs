#!/usr/bin/env node
/**
 * 计划页回归：日历点条目 / 备注栏铺满 / 任务详情浮层位置与开关。
 *
 * 前置：`npm run dev`（Vite 在 17800），夹具 src/features/plans/fixtures/{plan-calendar,plan-outline}.html
 * 用法：`node scripts/check-plans-browser.mjs`
 *
 * 断言：
 *   1. 日历点条目只触发 onTaskPick（带日期 + 任务 id），不触发格子点击；
 *   2. 点备注行 → 右侧备注栏出现且文本域自动聚焦、高度接近视口；
 *   3. 点 ⋯ → 任务详情浮层贴着按钮的右下方出现；Esc 关闭；
 *   4. 双击备注行同样打开详情浮层；
 *   5. 全程无运行时报错。
 */
import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const ORIGIN = process.env.ZENTAO_FIXTURE_ORIGIN ?? "http://127.0.0.1:17800";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const NOTE = "导出时右侧会溢出一列";

try {
  /* ── 日历：点条目 ≠ 点格子 ── */
  await page.goto(`${ORIGIN}/src/features/plans/fixtures/plan-calendar.html`, { waitUntil: "networkidle" });
  const chip = page.locator("[data-chip]").first();
  await chip.waitFor({ timeout: 15000 });
  const chipTitle = await chip.getAttribute("title");
  await chip.click();
  const picked = await page.evaluate(() => ({ picks: window.calendarReview.picks, taskPicks: window.calendarReview.taskPicks }));
  assert.equal(picked.taskPicks.length, 1, "点条目应当走 onTaskPick");
  assert.equal(picked.taskPicks[0][1] !== "", true, "onTaskPick 必须带上任务 id");
  assert.deepEqual(picked.picks, [], "点条目不应同时触发格子点击（否则会被带去归档）");
  console.log(`✓ 日历：点「${chipTitle}」只走 onTaskPick，格子点击未触发`);

  /* ── 大纲：备注栏 / 详情浮层 ── */
  await page.goto(`${ORIGIN}/src/features/plans/fixtures/plan-outline.html`, { waitUntil: "networkidle" });
  await page.getByText(NOTE).first().click();
  const note = page.locator("[data-note-title]");
  await note.waitFor({ timeout: 8000 });
  const focusTag = await page.evaluate(() => document.activeElement?.tagName ?? "");
  assert.equal(focusTag, "TEXTAREA", "打开备注栏后光标应当落在文本域里");
  const noteBox = await note.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(noteBox.height > viewport.height * 0.55, `备注栏应铺满高度（实际 ${Math.round(noteBox.height)}px / ${viewport.height}px）`);
  console.log(`✓ 备注栏：高 ${Math.round(noteBox.height)}px（视口 ${viewport.height}px），文本域已聚焦`);

  const trigger = page.getByLabel("任务详情").first();
  const triggerBox = await trigger.boundingBox();
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 8000 });
  const dialogBox = await dialog.boundingBox();
  assert.ok(dialogBox.x >= triggerBox.x - 8, "详情浮层应当出现在触发按钮的右侧，而不是回退到左边");
  assert.ok(dialogBox.y >= triggerBox.y, "详情浮层应当出现在按钮下方");
  console.log(`✓ 详情浮层：锚在按钮右下方（x ${Math.round(dialogBox.x)} ≥ ${Math.round(triggerBox.x)}）`);

  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached", timeout: 5000 });
  console.log("✓ Esc 关闭详情浮层");

  await page.getByText(NOTE).first().dblclick();
  await page.getByRole("dialog").waitFor({ timeout: 8000 });
  console.log("✓ 双击备注行也能打开详情浮层");

  assert.deepEqual(errors, []);
  console.log("PASS 计划页：日历条目、备注栏铺满、详情浮层右下锚定与双击打开");
} finally {
  await browser.close();
}
