import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 420 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const trigger = index => page.getByRole("combobox", { name: "关联项目任务", exact: true }).nth(index);
const taskOf = id => page.evaluate(id => {
  const store = window.bindingReview.stores.usePlans.getState();
  const day = Object.values(store.days)[0] ?? [];
  return day.find(task => task.id === id) ?? null;
}, id);
try {
  await page.goto(`${process.env.ZENTAO_FIXTURE_ORIGIN ?? "http://127.0.0.1:17800"}/src/features/plans/fixtures/plan-binding.html`);
  await trigger(0).waitFor();

  // 不再是系统画的 <select>：页面上一个原生下拉都不该有。
  assert.equal(await page.locator("select").count(), 0, "Plan binding must not use a native select");
  assert.equal(await page.getByRole("combobox", { name: "关联项目任务", exact: true }).count(), 2);

  // 顶层计划：未关联任务 → 选一个项目工作项（带项目名），写回 workItemId。
  assert.equal((await trigger(0).innerText()).includes("未关联任务"), true);
  await trigger(0).click();
  const options = await page.getByRole("option").allTextContents();
  assert.deepEqual(options, ["未关联任务", "保持游离", "业务门户 / 完善采购页面", "导出模板留白对不齐", "业务门户 / 旧版筛选器下线（已取消）"]);
  await page.getByRole("option", { name: "业务门户 / 完善采购页面", exact: true }).click();
  await page.waitForFunction(() => window.bindingReview.stores.usePlans.getState().days[Object.keys(window.bindingReview.stores.usePlans.getState().days)[0]].find(t => t.id === "task-1").workItemId === "item-alpha");
  await page.waitForFunction(() => document.querySelector('[role="combobox"][aria-label="关联项目任务"]')?.textContent?.includes("完善采购页面"));

  // 切成「保持游离」= workItemId 显式 null（与「未设置」区分开）。
  await trigger(0).click();
  await page.getByRole("option", { name: "保持游离", exact: true }).click();
  await page.waitForFunction(() => window.bindingReview.stores.usePlans.getState().days[Object.keys(window.bindingReview.stores.usePlans.getState().days)[0]].find(t => t.id === "task-1").workItemId === null);
  assert.equal((await taskOf("task-1")).workItemId, null);

  // 顶层计划选回「未关联任务」= 去掉这个字段（undefined），语义与旧实现一致。
  await trigger(0).click();
  await page.getByRole("option", { name: "未关联任务", exact: true }).click();
  await page.waitForFunction(() => window.bindingReview.stores.usePlans.getState().days[Object.keys(window.bindingReview.stores.usePlans.getState().days)[0]].find(t => t.id === "task-1").workItemId === undefined);

  // 子计划：「未关联任务」这一项变成「继承父计划 · <父标题>」。
  assert.equal((await trigger(1).innerText()).includes("继承父计划"), true, "Child plan must show the inherit option");

  // 键盘可达：聚焦 → 回车开 → 方向键移动 → 回车落；落地值必须与触发器上显示的一致。
  await trigger(0).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("listbox").waitFor();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const shown = await trigger(0).innerText();
  const written = (await taskOf("task-1")).workItemId;
  const expected = shown.includes("保持游离") ? null : /完善采购页面/.test(shown) ? "item-alpha" : /导出模板留白/.test(shown) ? "item-beta" : undefined;
  assert.equal(written, expected, `Keyboard selection must write what the trigger now shows (${shown})`);
  assert.notEqual(written, undefined, "Keyboard path must move off「未关联任务」");

  assert.deepEqual(errors, []);
  console.log("PASS plan binding: Radix dropdown replaces the native select, options and workItemId writeback (item / null / undefined), child inherit label, keyboard path");
} finally { await browser.close(); }
