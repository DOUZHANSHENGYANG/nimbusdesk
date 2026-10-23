import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1420, height: 900 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const cardStatus = () => page.evaluate(() => window.projectsReview.stores.useProjects.getState().items.find(item => item.id === "item-small").status);
const column = name => page.locator(`section[aria-label^="${name}"]`);
const iteration = () => page.getByRole("combobox", { name: "迭代", exact: true });
try {
  await page.goto(`${process.env.ZENTAO_FIXTURE_ORIGIN ?? "http://127.0.0.1:17800"}/src/features/projects/fixtures/page.html`);
  await page.getByRole("tab", { name: "总览" }).waitFor();
  // 看板在「全部项目」范围也在：不再依赖选中某个项目。
  assert.deepEqual(await page.getByRole("tab").allTextContents(), ["总览", "工作项", "看板"], "Board tab must exist without a selected project; files stays project-only");
  await page.getByRole("tab", { name: "工作项" }).click();
  await page.locator('[data-work-item="item-portal"]').first().waitFor();
  await page.getByRole("tab", { name: "看板" }).click();
  for (const name of ["待办", "进行中", "已完成", "已取消"]) assert.equal(await column(name).count(), 1, `${name} column must exist`);

  // 筛选在看板和列表之间共用：把迭代放到「全部」后，未排期的事项也要进看板。
  assert.equal(await page.getByRole("button", { name: "看全部状态" }).count(), 1, "Open filter must offer a one-click way to see closed columns");
  await iteration().click();
  await page.getByRole("option", { name: /全部迭代/ }).click();
  await page.locator('[data-work-item="item-small"]').waitFor();
  assert.equal(await page.locator('section[aria-label^="待办"] [data-work-item]').count(), 1);
  assert.equal(await cardStatus(), "todo");

  // 拖卡片跨列改状态，写回同一个 updateItem。
  await page.dragAndDrop('[data-work-item="item-small"]', 'section[aria-label^="进行中"] [role="list"]');
  await page.waitForFunction(() => window.projectsReview.stores.useProjects.getState().items.find(item => item.id === "item-small").status === "doing");
  assert.equal(await page.locator('section[aria-label^="进行中"] [data-work-item="item-small"]').count(), 1, "Card must render in its new column");

  // 拖回原列 = 状态回到待办。
  await page.dragAndDrop('[data-work-item="item-small"]', 'section[aria-label^="待办"] [role="list"]');
  await page.waitForFunction(() => window.projectsReview.stores.useProjects.getState().items.find(item => item.id === "item-small").status === "todo");

  // 卡片打开详情（键盘路径：状态在详情里改），Esc 收起。
  await page.locator('[data-work-item="item-small"] button[aria-pressed]').click();
  await page.locator(".projects-details").waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".projects-details"));

  // 切回列表：看板的筛选选择被带过去（同一份状态，不是两套）。
  await page.getByRole("tab", { name: "工作项" }).click();
  await page.locator('[data-work-item="item-small"]').waitFor();
  assert.equal((await iteration().innerText()).includes("全部迭代"), true, "Iteration filter must be shared between list and board");

  // 放到「全部状态」后，空列里给出拖放提示而不是空白。
  await page.getByRole("tab", { name: "看板" }).click();
  await page.getByRole("button", { name: "看全部状态" }).click();
  assert.equal(await page.getByRole("button", { name: "看全部状态" }).count(), 0, "Filter note disappears once all statuses are shown");
  assert.equal((await column("已完成").innerText()).includes("拖到这里"), true, "Empty column must explain where to drop");

  // 选中项目后多出「项目资料」：栏位条件没被移到 Tabs 外面时也不会丢。
  await page.locator(".projects-nav button.pl-5").first().click();
  assert.deepEqual(await page.getByRole("tab").allTextContents(), ["总览", "工作项", "看板", "项目资料"], "Files tab must come back for a selected project");
  await page.getByRole("tab", { name: "项目资料" }).click();
  await page.waitForTimeout(150);
  assert.equal((await page.locator("[data-slot='tabs-content']").first().innerText()).trim().length > 0, true, "Files panel must render its content");
  assert.equal(await page.locator('section[aria-label^="待办"]').count(), 0, "Board must unmount while files is open");

  assert.deepEqual(errors, []);
  console.log("PASS board: tab without project, four columns, shared filters, drag to change status both ways, details on click, empty column hint");
} finally { await browser.close(); }
