import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1420, height: 900 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const selectedTab = () => page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? "none");
const tile = key => page.locator(`[data-stat="${key}"] [data-stat-value]`).innerText().then(text => Number(text.trim()));
try {
  await page.goto(`${process.env.ZENTAO_FIXTURE_ORIGIN ?? "http://127.0.0.1:17800"}/src/features/projects/fixtures/page.html`);
  await page.locator('[data-stat="doing"]').waitFor();

  // 总览是落地页：一进来就是它，不是列表。
  assert.equal(await selectedTab(), "总览", "Overview must be the landing view");
  assert.equal(await tile("doing"), 1, "Only the item inside the current iteration is in scope");
  assert.equal(await tile("todo"), 0);
  assert.equal(await tile("done"), 0);

  // 卡片里的迭代下拉与页头共用一份状态：放到「全部迭代」后未排期的项也要出现。
  await page.getByRole("combobox", { name: "迭代", exact: true }).click();
  await page.getByRole("option", { name: /全部迭代/ }).click();
  await page.waitForFunction(() => document.querySelector('[data-stat="todo"] [data-stat-value]')?.textContent?.trim() === "1");
  assert.equal(await tile("doing"), 1);

  // 点总览里的一行 = 选中该项并就在这一屏开详情，不用跳去列表。
  await page.locator('[data-work-item="item-small"] button[aria-pressed]').first().click();
  await page.locator(".projects-details").waitFor();
  assert.equal(await selectedTab(), "总览", "Opening details must not switch the view");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".projects-details"));

  // 点「项目进度」的一行把范围收到那个项目：项目资料 tab 因此出现，且看板/列表的筛选保持同一份。
  await page.getByRole("button", { name: /业务门户/ }).first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('[role="tab"]')].length === 4);
  assert.deepEqual(await page.getByRole("tab").allTextContents(), ["总览", "工作项", "看板", "项目资料"]);
  assert.equal(await selectedTab(), "总览", "Narrowing the scope keeps the view you are on");
  // 项目范围内只剩该项目的工作项（「临时小需求」不属于任何项目，因此不在这一屏里）。
  assert.equal(await tile("todo"), 0);
  assert.equal(await tile("doing"), 1);

  // 状态在总览里如实汇总：切到列表把一项标成完成，总览的已完成与完成率跟着变。
  await page.getByRole("tab", { name: "工作项" }).click();
  await page.locator('[data-work-item="item-portal"] button[aria-pressed]').first().click();
  await page.locator(".projects-details").waitFor();
  await page.getByRole("combobox", { name: "状态", exact: true }).last().click();
  await page.getByRole("option", { name: "已完成", exact: true }).click();
  await page.waitForFunction(() => window.projectsReview.stores.useProjects.getState().items.find(item => item.id === "item-portal").status === "done");
  await page.getByRole("tab", { name: "总览" }).click();
  await page.waitForFunction(() => document.querySelector('[data-stat="done"] [data-stat-value]')?.textContent?.trim() === "1");
  assert.equal(await tile("doing"), 0, "The finished item must leave the in-progress tile");

  assert.deepEqual(errors, []);
  console.log("PASS overview: landing tab, tiles follow scope+iteration, row opens details in place, project row narrows scope, counts follow store writes");
} finally { await browser.close(); }
