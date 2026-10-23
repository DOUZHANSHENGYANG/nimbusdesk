#!/usr/bin/env node
/**
 * 搜索窗分片渲染回归：两个方向必须同时成立。
 *
 * A. **批加载不拽回列表** —— 用户滚到底、哨兵放下一批时，列表不能被滚回当前选中项
 *    （否则拖滚动条/触摸板翻页永远翻不过第二批）。
 * B. **跨批键盘导航要滚到** —— 按住 ↓ 越过已渲染范围时，选中项被补进 DOM 之后
 *    必须真的滚进视野（标记不能被「这一批还没渲染」那一趟提前消费）。
 *
 * 前置：`npm run dev`（Vite 在 17800）。夹具：`src/features/search/fixtures/page.html`
 * （只渲染搜索窗，桩了 IPC；`window.searchReview.resultOverride` 可注入任意条命中）。
 * 用法：`npm run check:search-window`
 */
import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const ORIGIN = process.env.FIXTURE_ORIGIN ?? "http://127.0.0.1:17800";
const TOTAL = 200;
const STEP = 80; // 搜索窗的分片步长

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 760, height: 560 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const rendered = () => page.evaluate(() => document.querySelectorAll(".quick-search-entry").length);
const scrollTop = () => page.evaluate(() => document.querySelector("#quick-search-results").scrollTop);
const scrollTo = (top) =>
  page.evaluate((value) => {
    const box = document.querySelector("#quick-search-results");
    box.scrollTop = value === "bottom" ? box.scrollHeight : value;
  }, top);

try {
  await page.goto(`${ORIGIN}/src/features/search/fixtures/page.html`, { waitUntil: "networkidle" });
  const input = page.getByRole("combobox");
  await input.waitFor();

  await page.evaluate((total) => {
    window.searchReview.resultOverride = Array.from({ length: total }, (_, index) => ({
      id: `hit-${index}`,
      kind: "file",
      title: `结果 ${index}`,
      subtitle: "",
      snippet: "",
      path: `E:\\Workspace\\file-${index}.txt`,
    }));
  }, TOTAL);

  await input.fill("a");
  await page.waitForTimeout(700);
  const first = await rendered();
  assert.ok(first > 0 && first < TOTAL, `首屏应只铺一批（当前 ${first} / ${TOTAL}）`);
  console.log(`✓ 首屏渲染 ${first} / ${TOTAL} 条`);

  /* ── A. 批加载不能把列表拽回选中项 ── */
  await scrollTo("bottom");
  await page.waitForTimeout(600);
  const afterGrow = await rendered();
  const keptTop = await scrollTop();
  assert.ok(afterGrow > first, `滚到底应放下一批（${first} → ${afterGrow}）`);
  assert.ok(keptTop > 200, `批加载不该把列表拽回顶部（scrollTop=${keptTop}）`);
  console.log(`✓ 批加载：${first} → ${afterGrow} 条，scrollTop 保持 ${keptTop}（没有被拽回选中项）`);

  /* ── B. 「一次补好几批」的键盘跳转也要滚到 ──
     重新加载一次，让「只渲染首批、列表在顶部」的初始状态确定（上一步已滚到过底部）。
     在选中第 0 条时按 ↑ 会回绕到最后一条：`revealForSelection` 一次把范围扩到覆盖它，
     而节点是**下一次渲染**才出现的 —— 标记若在「节点还不存在」那一趟就被消费，
     这一下就只补出、不滚动（选中项停在视口外）。 */
  await page.reload({ waitUntil: "networkidle" });
  await input.waitFor();
  await page.evaluate((total) => {
    window.searchReview.resultOverride = Array.from({ length: total }, (_, index) => ({
      id: `hit-${index}`,
      kind: "file",
      title: `结果 ${index}`,
      subtitle: "",
      snippet: "",
      path: `E:\\Workspace\\file-${index}.txt`,
    }));
  }, TOTAL);
  await input.fill("a");
  await page.waitForTimeout(700);
  const before = await rendered();
  assert.ok(before < TOTAL, `重新加载后应只铺首批（当前 ${before} / ${TOTAL}）`);

  const probe = () =>
    page.evaluate(() => {
      const box = document.querySelector("#quick-search-results");
      const selected = document.querySelector('[aria-selected="true"]');
      const index = selected?.getAttribute("data-search-index") ?? null;
      const node = index === null ? null : box?.querySelector(`[data-search-index="${index}"]`);
      const boxRect = box?.getBoundingClientRect();
      const nodeRect = node?.getBoundingClientRect();
      return {
        index: index === null ? null : Number(index),
        found: Boolean(node),
        inView: Boolean(boxRect && nodeRect && nodeRect.top >= boxRect.top - 4 && nodeRect.bottom <= boxRect.bottom + 4),
      };
    });

  await page.keyboard.press("ArrowUp"); // 第 0 条按 ↑：回绕到最后一条
  await page.waitForTimeout(500);
  const jumped = await probe();
  const after = await rendered();
  assert.equal(jumped.index, TOTAL - 1, `↑ 回绕应选中第 ${TOTAL - 1} 条（实际 ${jumped.index}）`);
  assert.ok(after > before, `跳转应扩容（${before} → ${after}）`);
  assert.equal(jumped.found, true, `第 ${jumped.index} 条的节点应该已经渲染出来`);
  assert.equal(jumped.inView, true, `跳转后必须滚到选中项（第 ${jumped.index} 条不能停在视口外）`);
  console.log(`✓ 跨批跳转：${before} → ${after} 条，选中第 ${jumped.index} 条并滚进可视区`);

  assert.deepEqual(errors, [], "分片与滚动逻辑不应产生运行时错误");
  console.log("\nPASS 搜索窗：批加载不拽回列表，跨批键盘导航滚得到，无运行时报错");
} finally {
  await browser.close();
}
