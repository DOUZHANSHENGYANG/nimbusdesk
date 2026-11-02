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

  // 侧栏结构：首页直达 + 三个一级分区（项目 / AI / 工具），标题本身就是入口。
  assert.equal(await page.getByRole("button", { name: "首页", exact: true }).count(), 1, "Home stays a direct top-level item");
  assert.equal(await page.getByRole("button", { name: "项目", exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "AI", exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "工具", exact: true }).count(), 1);

  // 资讯卡只显示一个渠道：默认是我订阅顺序里的第一个 RSS（这里是「AI 早报」）。
  assert.equal(await tile("feeds"), "5", "读数块统计的是所有有内容的源");
  const feedsCard = await card("今日资讯").innerText();
  assert.equal(feedsCard.includes("AI 早报"), true, "幻灯片先显示第一个有内容的源");
  assert.equal(feedsCard.includes("AI 早报 · 今天的模型与论文"), true, "条目来自这个源");

  // 换一张幻灯片：源名跟着变，条目跟着换
  await page.getByLabel("下一个信息源").click();
  await page.waitForTimeout(200);
  const nextSlide = await card("今日资讯").innerText();
  assert.notEqual(nextSlide, feedsCard, "翻页后内容应当变化");

  // 读数块就是入口：点「待办工作项」应当去项目页
  await page.locator('[data-stat="work"] button').first().click();
  await page.waitForSelector("[data-destination]");
  assert.equal(await page.locator("[data-destination]").innerText(), "/projects");
  await page.goBack();
  await page.locator('[data-stat="plans"]').waitFor();
  assert.match(await tile("plans"), /^\d+\/\d+$/, "回到首页读数块仍然在");

  // 收纳盒与 AI 资源两块都在
  await card("文件收纳盒").waitFor();
  await card("AI 资源").waitFor();

  assert.deepEqual(errors, []);
  console.log("PASS home: 读数块 + 近七天柱状 + 当前项目 + 今日资讯幻灯片 + 收纳盒 + AI 资源，深链仍通");
} finally { await browser.close(); }
