import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1420, height: 900 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const tile = key => page.locator(`[data-stat="${key}"] [data-stat-value]`).innerText().then(text => text.trim());
const view = name => page.getByRole("button", { name, exact: true });
const card = title => page.locator("section", { has: page.locator("h3", { hasText: title }) }).last();
try {
  await page.goto(`${process.env.ZENTAO_FIXTURE_ORIGIN ?? "http://127.0.0.1:17800"}/src/features/home/fixtures/page.html`);
  await page.locator('[data-stat="plans"]').waitFor();

  // 总览是落地视图，四张卡与四个数字格都在。
  assert.equal(await view("总览").getAttribute("aria-pressed"), "true", "Overview must be the landing view");
  assert.deepEqual(await page.locator("[data-stat]").evaluateAll(list => list.map(node => node.getAttribute("data-stat"))), ["plans", "work", "notes", "feeds"]);
  assert.equal(await tile("plans"), "1/4", "Plan tile counts today's done/total");
  assert.equal(await tile("work"), "3", "Open work items only");
  assert.equal(await tile("notes"), "2", "Inbox captures awaiting organize");
  assert.equal(await tile("feeds"), "3", "Entries merged across sources");

  // 卡片里点一条计划就勾选（写回 plans store），数字格跟着变。
  await card("今日计划").getByRole("checkbox").first().isVisible();
  const second = page.locator('[role="checkbox"]').nth(1);
  await second.click();
  await page.waitForFunction(() => {
    const plans = window.homeReview.stores.usePlans.getState();
    const day = Object.keys(plans.days)[0];
    return plans.days[day].filter(task => task.done).length === 2;
  });
  await page.waitForFunction(() => document.querySelector('[data-stat="plans"] [data-stat-value]')?.textContent?.trim() === "2/4");

  // 点待办工作项 → 去项目页，带上 ?item= 深链。
  await page.getByRole("button", { name: /导出模板留白对不齐/ }).click();
  await page.waitForSelector("[data-destination]");
  assert.equal(await page.locator("[data-destination]").innerText(), "/projects?item=item-export");

  // 点资讯条目 → 去资讯页。
  await page.goBack();
  await page.locator('[data-stat="plans"]').waitFor();
  await page.getByRole("button", { name: /SQLite 的一个新扩展/ }).click();
  await page.waitForSelector("[data-destination]");
  assert.equal(await page.locator("[data-destination]").innerText(), "/feeds");

  // 笔记卡显示收件箱条目与相对时间。
  await page.goBack();
  await page.locator('[data-stat="notes"]').waitFor();
  assert.equal((await card("笔记").innerText()).includes("Postgres 索引调优笔记"), true, "Notes card lists inbox captures");
  assert.equal((await card("笔记").innerText()).includes("分钟前"), true, "Notes card shows relative time");

  // 原来的两个视图没被顶掉。
  await view("清单").click();
  await page.waitForFunction(() => document.body.innerText.includes("上午"));
  await view("脉络").click();
  await page.waitForTimeout(300);
  await view("总览").click();
  await page.locator('[data-stat="plans"]').waitFor();

  assert.deepEqual(errors, []);
  console.log("PASS home overview: landing tab, four tiles, plan checkbox writes back, work item and feed deep links, notes list, list/orbit views intact");
} finally { await browser.close(); }
