import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));

const titleButton = () => page.getByRole("button", { name: /对齐导出模板/ }).first();
const panel = () => page.getByRole("dialog", { name: "任务详情" });
const dayTasks = date => page.evaluate(date => (window.outlineReview.stores.usePlans.getState().days[date] ?? [])
  .map(task => ({ id: task.id, title: task.title, parentId: task.parentId })), date);
const rowBox = () => page.locator('[data-search-task-id="task-1"]').boundingBox();

try {
  await page.goto(`${process.env.ZENTAO_FIXTURE_ORIGIN ?? "http://127.0.0.1:17800"}/src/features/plans/fixtures/plan-outline.html`);
  await titleButton().waitFor();
  const today = await page.evaluate(() => window.outlineReview.days.today);
  const tomorrow = await page.evaluate(() => window.outlineReview.days.tomorrow);
  await page.waitForTimeout(400); // 让行入场动画跑完，后面才量得到稳定几何

  // 详情是浮层：点标题开面板，行的几何不因此改变（旧实现是就地展开，行会变高）
  const before = await rowBox();
  await titleButton().click();
  await panel().waitFor();
  assert.deepEqual(await rowBox(), before, "Opening the detail panel must not move or resize the row");

  // 面板是唯一的编辑场所：字段名就是词表里的标签，附件是内联列表而不是再套一层浮层
  for (const label of ["日期", "时间", "关联", "项目", "备注"])
    assert.equal(await panel().getByText(label, { exact: true }).count(), 1, `Panel must have exactly one ${label} field`);
  assert.equal(await panel().getByRole("button", { name: "删除" }).count(), 1);
  assert.equal(await panel().getByText("附件", { exact: true }).count(), 1);
  assert.equal(await page.locator('[data-slot="popover-content"]').count(), 1, "The panel alone must not stack a second popover");

  // 标题：回车落地并收起面板（逐字符写库会把撤销栈灌满，所以只在提交时写一次）
  await panel().getByRole("textbox", { name: "标题" }).fill("对齐导出模板的三处列宽");
  await page.keyboard.press("Enter");
  await panel().waitFor({ state: "hidden" });
  const renamed = await dayTasks(today);
  assert.equal(renamed.find(task => task.id === "task-1").title, "对齐导出模板的三处列宽");
  assert.equal((await titleButton().innerText()).includes("三处列宽"), true, "Row must show the saved title");

  // 加子任务：入口在面板里，回车即落库
  await titleButton().click();
  await panel().waitFor();
  await panel().getByRole("textbox", { name: "添加子任务" }).fill("再核一遍表头");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /再核一遍表头/ }).first().waitFor();

  // 改期：点「明天」把这一条（含子树）挪走，今天的行随之消失
  await panel().getByRole("button", { name: /^日期/ }).click();
  await page.getByRole("button", { name: "明天", exact: true }).click();
  await panel().waitFor({ state: "hidden" });
  await page.waitForFunction(() => (window.outlineReview.stores.usePlans.getState().days[window.outlineReview.days.tomorrow] ?? []).length === 3);
  assert.deepEqual(await dayTasks(today), [], "Moved task must leave today");
  const moved = await dayTasks(tomorrow);
  assert.equal(moved.find(task => task.id === "task-2").parentId, "task-1", "Subtasks must move along");

  // 空状态本身就是入口：这一天空了，点提示词要把光标放回快速添加框
  const addBox = page.getByPlaceholder("输入后回车添加…").first();
  await page.getByRole("button", { name: /这一天还没有计划/ }).click();
  assert.equal(await addBox.evaluate(node => node === document.activeElement), true, "Empty state must focus the quick-add input");

  assert.deepEqual(errors, []);
  console.log("PASS plan outline: detail panel opens without moving the row, edits write once, subtask add, move-to-day keeps subtasks, empty state focuses the add box");
} finally { await browser.close(); }
