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

  /* ── 行级增量写入：改一条只推一条，不做整份重写 ── */
  await page.evaluate(async () => {
    const { useFiles } = await import("/src/stores/files.ts");
    const items = useFiles.getState().items.map((item, index) => (index === 0 ? { ...item, title: "只改这一条" } : item));
    useFiles.setState({ items });
  });
  await page.waitForFunction(() => window.filesReview.applied.length > 0, undefined, { timeout: 10000 });
  const applied = await page.evaluate(() => window.filesReview.applied.at(-1));
  assert.equal(applied.items.upsert.length, 1, `改一条应只推一条（实际 ${applied.items.upsert.length}）`);
  assert.equal(applied.items.upsert[0].value.title, "只改这一条");
  assert.equal(applied.items.reorder.length, 0, "内容变了但位置没变，不该产生 reorder");
  console.log("✓ 行级写入：改一条只推一条");

  /* ── 三种视图切换：图标 / 列表 / 收纳盒 ──
     收纳盒视图必须按分类出盒子（数量徽标不显示 0），点盒子进该分类网格；
     切到收纳盒时内容顶边不能跳（布局抖动的回归点）。 */
  const gridBox = await page.locator("[data-card]").first().boundingBox();
  await page.getByRole("button", { name: "收纳盒视图" }).click();
  await page.locator("[data-files-boxes]").waitFor({ timeout: 5000 });
  const boxCards = page.locator("[data-files-boxes] [data-box-card]");
  assert.equal(await boxCards.count(), 2, "两个分类应渲染两个收纳盒方块");
  assert.equal(await boxCards.first().locator("[data-box-badge]").textContent(), String(TOTAL), "数量徽标应显示分类条目数");
  assert.equal(await boxCards.first().locator("[data-box-preview] > span > *").count(), 6, "3×3 预览只放前 6 个图标");
  const boxesBox = await page.locator("[data-files-boxes]").boundingBox();
  assert.ok(gridBox && boxesBox && Math.abs(gridBox.y - boxesBox.y) <= 1, "切到收纳盒视图时内容顶边不应跳动");
  console.log("✓ 收纳盒视图：分类方块 / 数量徽标 / 6 个预览图标，切换无纵向抖动");

  await boxCards.first().click();
  await page.locator("[data-files-boxes]").waitFor({ state: "detached", timeout: 5000 });
  await page.getByRole("button", { name: "返回收纳盒" }).waitFor({ timeout: 5000 });
  assert.ok((await page.locator("[data-card]:visible").count()) > 0, "点开收纳盒后应显示该分类的条目网格");
  await page.getByRole("button", { name: "返回收纳盒" }).click();
  await page.locator("[data-files-boxes]").waitFor({ timeout: 5000 });

  await page.getByRole("button", { name: "列表视图" }).click();
  await page.locator("[data-files-list]").waitFor({ timeout: 5000 });
  assert.equal(await page.locator("[data-files-list] [data-card]").count(), STEP, "列表视图也应按分片只铺第一批");
  await page.getByRole("button", { name: "图标视图" }).click();
  await page.locator("[data-files-boxes]").waitFor({ state: "detached", timeout: 5000 });
  console.log("✓ 列表视图按分片渲染；三种视图可来回切换");

  /* ── 深链定位：目标条目排在第 200 位（远超首批），也必须被滚进视野 ──
     这一步必须在「滚满全量」之前做，否则目标早就在 DOM 里，测不出分片下的定位逻辑。 */
  await page.evaluate(() => { window.location.hash = "#/files?item=bulk-200"; });
  await page.waitForFunction(
    () => {
      const card = [...document.querySelectorAll("[data-card]")]
        .find(node => (node.getAttribute("data-item-id") ?? "") === "bulk-200");
      if (!card) return false;
      const box = card.getBoundingClientRect();
      return box.top >= -8 && box.bottom <= window.innerHeight + 8;
    },
    undefined,
    { timeout: 15000 },
  );
  const afterJump = await cards();
  assert.ok(afterJump < TOTAL, `深链定位不应把整份列表铺开（当前 ${afterJump} / ${TOTAL}）`);
  console.log(`✓ 深链 /files?item=<第 200 条> 已滚进视野，此时渲染 ${afterJump} 张卡片`);

  /* ── 带过滤时的深链：当前搜索词把目标筛掉，深链仍必须定位到它 ──
     深链会自己清空搜索、切分类，那些状态到下一次渲染才生效；若按「旧过滤条件下找不到」
     就放弃，用户从全局搜索跳过来只会看到网格顶部（上一轮 bug 的形态）。 */
  await page.locator("input").first().fill("no-such-file-zzz");
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.location.hash = "#/files?item=bulk-300"; });
  await page.waitForFunction(
    () => {
      const card = [...document.querySelectorAll("[data-card]")]
        .find(node => (node.getAttribute("data-item-id") ?? "") === "bulk-300");
      if (!card) return false;
      const box = card.getBoundingClientRect();
      return box.top >= -8 && box.bottom <= window.innerHeight + 8;
    },
    undefined,
    { timeout: 15000 },
  );
  const afterFilteredJump = await cards();
  assert.ok(afterFilteredJump < TOTAL, `带过滤的深链也不该铺开全量（当前 ${afterFilteredJump} / ${TOTAL}）`);
  console.log(`✓ 带过滤的深链 /files?item=<第 300 条> 已滚进视野，此时渲染 ${afterFilteredJump} 张卡片`);

  // 反复滚到底，看能不能续上
  let rounds = 0;
  let previous = afterFilteredJump;
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
  console.log("\nPASS 文件页：分片渲染生效，滚动可续至全量，深链能定位到首批之外的条目，无运行时报错");
} finally {
  await browser.close();
}
