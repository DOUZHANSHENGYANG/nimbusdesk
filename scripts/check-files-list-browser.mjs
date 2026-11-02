#!/usr/bin/env node
/**
 * 文件收纳页回归：分片渲染 / 行级写入 / 收纳盒墙 / 盒子浮层 / 深链定位。
 *
 * 前置：`npm run dev`（Vite 在 17800），夹具 `src/features/files/fixtures/page.html`。
 * 用法：`node scripts/check-files-list-browser.mjs`
 *
 * 断言：
 *   1. 墙上按分类出方块，数量徽标等于该分类条目数；
 *   2. 点方块打开浮层，条目网格只在浮层里渲染（外面不再有第二份）；
 *   3. 800 个条目时首屏远小于总数；反复滚到底能铺满（不会漏、不会卡）；
 *   4. 改一条只推一条（行级写入没退化成整份重写）；
 *   5. 深链 /files?item=<第 200 条> 会自动打开它所在的盒子并滚进视野；
 *   6. 全程无运行时错误。
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

const cards = () => page.locator("[data-box-panel] [data-card]").count();
const panel = () => page.locator("[data-box-panel]");

try {
  await page.goto(`${ORIGIN}/src/features/files/fixtures/page.html`);
  await page.locator("[data-files-boxes]").waitFor({ timeout: 20000 });

  /* ── 墙：按分类出方块 ── */
  const boxCards = page.locator("[data-files-boxes] [data-box-card]");
  assert.equal(await boxCards.count(), 2, "两个分类应渲染两个收纳盒方块");
  assert.ok(await page.locator("[data-files-boxes] [data-box-new]").count() === 1, "墙末尾要有「新建收纳盒」");
  assert.equal(await page.locator("[data-card]").count(), 0, "没打开盒子时不应该有第二份条目网格");
  console.log("✓ 收纳盒墙：两个方块 + 新建入口，网格只在盒子浮层里");

  /* ── 点开第一个盒子，把 800 条塞进它所属分类 ── */
  const firstCategoryId = await boxCards.first().getAttribute("data-cat-id");
  assert.ok(firstCategoryId, "方块要带 data-cat-id，右键菜单与深链都靠它");
  await boxCards.first().click();
  await panel().waitFor({ timeout: 5000 });

  await page.evaluate(async ({ total, categoryId }) => {
    const { useFiles } = await import("/src/stores/files.ts");
    const base = useFiles.getState().items[0];
    useFiles.setState({
      items: Array.from({ length: total }, (_, index) => ({
        ...base,
        id: `bulk-${index}`,
        categoryId,
        title: `压力测试文件 ${index}`,
        path: `E:/bulk/file-${index}.txt`,
        tags: index % 7 === 0 ? ["标签"] : [],
        createdAt: index,
      })),
    });
  }, { total: TOTAL, categoryId: firstCategoryId });

  await page.waitForFunction((min) => document.querySelectorAll("[data-box-panel] [data-card]").length > min, STEP, { timeout: 15000 });
  const first = await cards();
  assert.ok(first >= STEP, `首屏至少要铺第一批（当前 ${first}）`);
  assert.ok(first < TOTAL, `首屏不能一次铺完（当前 ${first} / ${TOTAL}）——分片没生效`);
  console.log(`✓ 首屏渲染 ${first} / ${TOTAL} 张卡片（分片生效）`);

  /* ── 行级增量写入：改一条只推一条 ── */
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

  /* ── 关掉浮层：回到墙，徽标是真实条目数 ── */
  await page.locator("[data-box-panel] header button").last().click();
  await page.locator("[data-files-boxes]").waitFor({ timeout: 5000 });
  const badge = page.locator(`[data-box-card][data-cat-id="${firstCategoryId}"] [data-box-badge]`);
  assert.equal(await badge.textContent(), String(TOTAL), "数量徽标应显示分类条目数");
  console.log("✓ 关掉浮层回到墙，徽标 = 分类条目数");

  /* ── 墙上方块：预览图标是拖拽源（真正的换盒由 move-between-boxes 单测覆盖） ── */
  const dragSource = await page.evaluate(() => {
    const icons = [...document.querySelectorAll("[data-tile-item]")];
    return { total: icons.length, draggable: icons.filter(node => node.getAttribute("draggable") === "true").length };
  });
  assert.ok(dragSource.total > 0, "盒子上应该能看到预览图标");
  assert.equal(dragSource.draggable, dragSource.total, "墙上的预览图标都必须可拖动");
  console.log(`✓ 墙上方块：${dragSource.total} 个预览图标可拖`);

  /* ── 深链：自动打开目标所在盒子并滚进视野 ── */
  await page.evaluate(() => { window.location.hash = "#/tools/files?item=bulk-200"; });
  await page.waitForFunction(
    () => {
      const card = [...document.querySelectorAll("[data-box-panel] [data-card]")]
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
  console.log(`✓ 深链 /files?item=<第 200 条> 自动开盒并滚进视野，此时渲染 ${afterJump} 张卡片`);

  /* ── 反复滚到底，看能不能续上 ── */
  let rounds = 0;
  let previous = afterJump;
  while (previous < TOTAL && rounds < 40) {
    await page.evaluate(() => {
      const nodes = document.querySelectorAll("[data-box-panel] [data-card]");
      nodes[nodes.length - 1]?.scrollIntoView({ block: "end" });
    });
    await page.waitForTimeout(120);
    const now = await cards();
    if (now === previous) rounds++;
    else { rounds = 0; previous = now; }
  }
  assert.equal(previous, TOTAL, `滚动应能续到全量（当前 ${previous} / ${TOTAL}）`);
  console.log(`✓ 滚动续批 ${rounds} 轮后铺满 ${previous} 条`);

  assert.deepEqual(errors, []);
  console.log("PASS 文件收纳：墙 / 浮层 / 分片 / 行级写入 / 深链定位 / 滚动续批，无运行时报错");
} finally {
  await browser.close();
}
