import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));

/** 行内的按钮都按行 id 定位 —— 它们的 aria-label 里也带标题，按标题找会撞上 */
const rowOf = id => page.locator(`[data-search-task-id="${id}"]`);
const titleButton = id => rowOf(id).locator('button[title="打开任务详情"]');
const grip = id => rowOf(id).locator('button[title="拖动排序（同一层级）"]');
/** 详情是列表右边的一栏（aside → role=complementary），不是浮层 */
const panel = () => page.getByRole("complementary", { name: "任务详情" });
const dayTasks = date => page.evaluate(date => (window.outlineReview.stores.usePlans.getState().days[date] ?? [])
  .map(task => ({ id: task.id, title: task.title, parentId: task.parentId })), date);
const idsOf = date => dayTasks(date).then(tasks => tasks.map(task => task.id));
/** 行的高度与位置：详情栏一开列表会变窄，但夹具给了足够宽度的窗口，
    正常窗宽下不该出现换行 —— 换行会让下方所有行整体下移，那正是要盯住的那类抖动 */
const verticalBox = async id => {
  const box = await rowOf(id).boundingBox();
  return { y: Math.round(box.y), height: Math.round(box.height) };
};
/** 详情栏当前显示的是不是这一条（按标题输入框的值判断，不靠「点了几次」猜开关状态） */
const detailShows = async title =>
  (await panel().isVisible()) && (await panel().getAttribute("data-note-title")) === title;
/** 让详情栏停在某一条上：已经是它就不动，否则点标题选中它 */
const select = async (id, title) => {
  if (await detailShows(title)) return;
  await titleButton(id).click();
  await panel().waitFor();
};

try {
  await page.goto(`${process.env.ZENTAO_FIXTURE_ORIGIN ?? "http://127.0.0.1:17800"}/src/features/plans/fixtures/plan-outline.html`);
  await titleButton("task-1").waitFor();
  const today = await page.evaluate(() => window.outlineReview.days.today);
  const tomorrow = await page.evaluate(() => window.outlineReview.days.tomorrow);
  await page.waitForTimeout(400); // 让行入场动画跑完，后面才量得到稳定几何

  // 详情栏：点标题出现，行的**纵向**几何不变（旧实现是就地展开，行会变高）
  const before = await verticalBox("task-1");
  await titleButton("task-1").click();
  await panel().waitFor();
  assert.deepEqual(await verticalBox("task-1"), before, "Opening the detail column must not move or resize the row");
  assert.equal(await rowOf("task-1").locator('button[title="更多操作"]').count(), 0, "The ⋯ entry must be gone — the title itself opens the detail");
  assert.equal(await page.locator('[data-slot="popover-content"]').count(), 0, "Detail must be a column, not a floating layer");

  // 右栏只剩备注：进来就能写；其它字段都搬进 ⋯ 浮层
  assert.equal(await panel().getByRole("textbox", { name: "备注" }).count(), 1, "Note must be a textarea");
  for (const label of ["日期", "时间", "关联", "项目"])
    assert.equal(await panel().getByText(label, { exact: true }).count(), 0, `Note column must not carry a ${label} field`);

  // ⋯ 打开完整详情卡片（原来看板/大纲都靠它）
  await rowOf("task-1").locator('button:has-text("⋯")').click();
  for (const label of ["日期", "时间", "关联", "项目", "备注"])
    assert.equal(await page.getByText(label, { exact: true }).count(), 1, `Detail card must have exactly one ${label} field`);
  assert.equal(await page.getByRole("button", { name: "删除" }).count(), 1);
  assert.equal(await page.getByText("附件", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("textbox", { name: "添加子任务" }).count(), 1, "Detail card keeps its own subtask field");

  // 标题下面那行备注也是入口：点它进来，光标直接落在备注里
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "导出时右侧会溢出一列" }).click();
  const noteBox = panel().getByRole("textbox", { name: "备注" });
  assert.equal(await noteBox.evaluate(node => node === document.activeElement), true, "Clicking the note line must put the caret in the note");

  // 标题：回车落地但不收栏 —— 标题现在在 ⋯ 浮层里编辑
  await rowOf("task-1").locator('button:has-text("⋯")').click();
  await page.getByRole("textbox", { name: "标题" }).fill("对齐导出模板的三处列宽");
  await page.keyboard.press("Enter");
  assert.equal((await dayTasks(today)).find(task => task.id === "task-1").title, "对齐导出模板的三处列宽");
  assert.equal((await titleButton("task-1").innerText()).includes("三处列宽"), true, "Row must show the saved title");
  assert.equal(await panel().isVisible(), true, "Enter must keep the detail column open");
  await page.keyboard.press("Escape"); // 关掉 ⋯ 浮层：背板会挡住后面的行点击

  // 选中是开关：再点标题就收起，点回来又有
  await titleButton("task-1").click();
  await panel().waitFor({ state: "hidden" });
  await titleButton("task-1").click();
  await panel().waitFor();

  // 加子任务：行上的 + 长出输入框，回车即落库（详情栏里也有同一入口）
  await rowOf("task-1").locator('button[title="添加子任务"]').click();
  await page.locator("[data-row]").first().getByRole("textbox", { name: "添加子任务" }).fill("再核一遍表头");
  await page.keyboard.press("Enter");
  const childId = (await dayTasks(today)).find(task => task.title === "再核一遍表头").id;
  await rowOf(childId).waitFor();

  // 拖动排序：抓住把手把第二条根任务拖到第一条上半边 = 插到它前面
  assert.deepEqual(await idsOf(today), ["task-1", "task-2", "task-3", childId]);
  await grip("task-3").dragTo(rowOf("task-1"), { targetPosition: { x: 180, y: 4 } });
  await page.waitForFunction(() => window.outlineReview.stores.usePlans.getState().days[window.outlineReview.days.today][0].id === "task-3");
  assert.deepEqual(await idsOf(today), ["task-3", "task-1", "task-2", childId], "Drag must move the dragged row only");
  assert.deepEqual(await page.locator("[data-search-task-id]").evaluateAll(nodes => nodes.map(node => node.dataset.searchTaskId)),
    ["task-3", "task-1", childId, "task-2"], "DOM order must match the display order (done sinks)");

  // 完成分组：头带计数、可折叠；收起只是不渲染，数据一条不少
  const doneHeader = page.getByRole("button", { name: /^已完成/ });
  await doneHeader.waitFor();
  assert.equal(await doneHeader.getAttribute("aria-expanded"), "true", "Done group starts expanded");
  await rowOf("task-2").waitFor();
  await doneHeader.click();
  assert.equal(await doneHeader.getAttribute("aria-expanded"), "false");
  await rowOf("task-2").waitFor({ state: "hidden" });
  assert.equal((await dayTasks(today)).some(task => task.id === "task-2"), true, "Collapsing must not drop the task");
  await doneHeader.click();
  await rowOf("task-2").waitFor();

  // 键盘路径：把手聚焦后 ↑↓ 换位（拖动不该是唯一的换位方式）。
  // 落点在整个子树之后：换位以「一条 + 它的子任务」为单位，插不进别人家子树中间
  await grip("task-3").focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => window.outlineReview.stores.usePlans.getState().days[window.outlineReview.days.today][0].id === "task-1");
  assert.deepEqual(await idsOf(today), ["task-1", "task-2", childId, "task-3"], "Arrow keys must reorder too");

  // 改期：点「明天」把这一条（含子树）挪走，今天的行与详情栏一起消失
  await select("task-1", "对齐导出模板的三处列宽");
  await panel().getByRole("button", { name: /^日期/ }).click();
  await page.getByRole("button", { name: "明天", exact: true }).click();
  await panel().waitFor({ state: "hidden" });
  await page.waitForFunction(() => (window.outlineReview.stores.usePlans.getState().days[window.outlineReview.days.tomorrow] ?? []).length === 3);
  assert.deepEqual(await idsOf(today), ["task-3"], "Only the moved subtree leaves today");
  assert.equal((await dayTasks(tomorrow)).find(task => task.id === "task-2").parentId, "task-1", "Subtasks must move along");

  // 最后一条也挪走：空状态本身就是入口，点提示词要把光标放回快速添加框
  await select("task-3", "导出后把表头和列宽拿真数据再核一遍");
  await panel().getByRole("button", { name: /^日期/ }).click();
  await page.getByRole("button", { name: "明天", exact: true }).click();
  await page.waitForFunction(() => (window.outlineReview.stores.usePlans.getState().days[window.outlineReview.days.today] ?? []).length === 0);
  const addBox = page.getByPlaceholder("输入后回车添加…").first();
  await page.getByRole("button", { name: /这一天还没有计划/ }).click();
  assert.equal(await addBox.evaluate(node => node === document.activeElement), true, "Empty state must focus the quick-add input");

  assert.deepEqual(errors, []);
  console.log("PASS plan outline: detail column keeps the row geometry, edits write once, subtask add, drag reorder, move-to-day, empty state focuses the add box");
} finally { await browser.close(); }
