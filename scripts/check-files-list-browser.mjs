#!/usr/bin/env node
/**
 * 文件页分片渲染回归：上千个条目时 DOM 不能一次铺满，滚到底要能续上。
 *
 * 前置：`npm run dev`（Vite 在 17800），夹具 `src/features/files/fixtures/page.html`。
 * 用法：`node scripts/check-files-list-browser.mjs`
 *
 * 断言：
 *   1. 800 个条目时，首屏渲染的卡片数远小于总数（分片生效）；
 *   2. 反复滚到底，最终能把全部条目铺出来（不会漏、不会卡在第一批）；
 *   3. 全程无运行时错误。
 */
import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const ORIGIN = process.env.FIXTURE_ORIGIN ?? "http://127.0.0.1:17800";
const TOTAL = 800;
const STEP = 120;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const cards = () => page.locator("[data-card]").count();

try {
  await page.goto(`${ORIGIN}/src/features/files/fixtures/page.html`);
  await page.locator("[data-card]").first().waitFor({ timeout: 20000 });

  // 塞 800 条进去（真实使用里「整目录映射」就是这个量级）
  await page.evaluate(async (total) => {
    const { useFiles } = await import("/src/stores/files.ts");
    const base = useFiles.getState().items[0];
    useFiles.setState({
      items: Array.from({ length: total }, (_, index) => ({
        ...base,
        id: `bulk-${index}`,
        title: `压力测试文件 ${index}`,
        path: `E:/bulk/file-${index}.txt`,
        tags: index % 7 === 0 ? ["标签"] : [],
        createdAt: index,
      })),
    });
  }, TOTAL);

  await page.waitForFunction((min) => document.querySelectorAll("[data-card]").length > min, STEP, { timeout: 15000 });
  const first = await cards();
  assert.ok(first >= STEP, `首屏至少要铺第一批（当前 ${first}）`);
  assert.ok(first < TOTAL, `首屏不能一次铺完（当前 ${first} / ${TOTAL}）——分片没生效`);
  console.log(`✓ 首屏渲染 ${first} / ${TOTAL} 张卡片（分片生效）`);

  // 反复滚到底，看能不能续上
  let rounds = 0;
  let previous = first;
  while (previous < TOTAL && rounds < 40) {
    await page.evaluate(() => {
      document.querySelector("[data-card]:last-of-type")?.scrollIntoView({ block: "end" });
      const sentinel = [...document.querySelectorAll("div[aria-hidden]")].at(-1);
      sentinel?.scrollIntoView({ block: "end" });
    });
    await page.waitForTimeout(120);
    const now = await cards();
    if (now === previous) {
      // 哨兵可能需要再滚一次容器
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(160);
    }
    previous = await cards();
    rounds += 1;
  }
  assert.equal(previous, TOTAL, `滚到底后应能铺出全部 ${TOTAL} 条，实际 ${previous}`);
  console.log(`✓ 滚动续批 ${rounds} 轮后铺满 ${previous} 条`);

  assert.deepEqual(errors, [], "分片渲染不应产生运行时错误");
  console.log("\nPASS 文件页：分片渲染生效，滚动可续至全量，无运行时报错");
} finally {
  await browser.close();
}
