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

  // 总览是落地视图；「清单」不再是一个视图（那一屏就是一行孤零零的计划 + 大片空白）。
  assert.equal(await view("总览").getAttribute("aria-pressed"), "true", "Overview must be the landing view");
  assert.equal(await page.getByRole("button", { name: "清单", exact: true }).count(), 0, "The list view must be gone");
  assert.equal(await page.getByRole("button", { name: "脉络", exact: true }).count(), 1, "Orbit stays as the second view");
  assert.deepEqual(await page.locator("[data-stat]").evaluateAll(list => list.map(node => node.getAttribute("data-stat"))), ["plans", "work", "notes", "feeds"]);

  // 侧栏一级只剩「工作台 / 资料」：AI 不再是顶级菜单，它的条目落在「资料」里。
  assert.equal(await page.getByRole("button", { name: "AI", exact: true }).count(), 0, "AI must not be a top-level menu any more");
  assert.equal(await page.getByRole("button", { name: "工作台", exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "资料", exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: /^对话/ }).count(), 1, "AI items live under 资料 now");
  assert.equal(await page.getByRole("button", { name: /^技能/ }).count(), 1);

  // 资讯卡只显示一个渠道：默认是我订阅顺序里的第一个 RSS（这里是「AI 早报」）。
  assert.equal(await tile("feeds"), "2", "Default channel is the first subscription");
  const feedsCard = await card("资讯").innerText();
  assert.equal(feedsCard.includes("AI 早报"), true, "Card header names the channel in use");
  assert.equal(feedsCard.includes("AI 早报 · 今天的模型与论文"), true, "Entries come from that channel");
  assert.equal(feedsCard.includes("SQLite 的一个新扩展"), false, "Entries from other channels must not leak in");

  // 设置里换一个渠道：卡片跟着换（这里直接写 store，等价于设置页选完的效果）。
  await page.evaluate(() => window.homeReview.stores.useSettings.getState().setHomeFeedSource("hackernews"));
  await page.waitForFunction(() => (document.body.innerText ?? "").includes("SQLite 的一个新扩展"));
  assert.equal(await tile("feeds"), "2");
  await page.evaluate(() => window.homeReview.stores.useSettings.getState().setHomeFeedSource("nope-deleted"));
  await page.waitForFunction(() => (document.body.innerText ?? "").includes("AI 早报 · 今天的模型与论文"));
  await page.evaluate(() => window.homeReview.stores.useSettings.getState().setHomeFeedSource(null));

  // 深链与勾选仍然工作。
  await page.locator('[data-work-item="item-export"] button[aria-pressed]').first().click().catch(async () => {
    await page.getByRole("button", { name: /导出模板留白对不齐/ }).click();
  });
  await page.waitForSelector("[data-destination]");
  assert.equal(await page.locator("[data-destination]").innerText(), "/projects?item=item-export");
  await page.goBack();
  await page.locator('[data-stat="plans"]').waitFor();
  await page.locator('[role="checkbox"]').nth(1).click();
  await page.waitForFunction(() => document.querySelector('[data-stat="plans"] [data-stat-value]')?.textContent?.trim() === "2/4");

  assert.deepEqual(errors, []);
  console.log("PASS home: no list view, two top-level menu groups with AI under 资料, feeds card pinned to the first subscription with a switchable channel, deep link and plan checkbox still work");
} finally { await browser.close(); }
