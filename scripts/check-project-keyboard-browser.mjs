import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const button = name => page.getByRole("button", { name, exact: true });
const dialog = () => page.getByRole("dialog");
try {
  await page.goto(`${process.env.ZENTAO_FIXTURE_ORIGIN ?? "http://127.0.0.1:17800"}/src/features/projects/fixtures/page.html`);
  await button("新建业务范围").click();
  const input = page.getByRole("textbox", { name: "新建业务范围", exact: true });
  await input.waitFor(); await page.waitForTimeout(600);
  assert.equal(await input.evaluate(element => element === document.activeElement), true, "New category must focus its name, not the close button");
  await page.keyboard.type("回车分类"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.projectsReview.stores.useProjects.getState().areas.some(value => value.name === "回车分类"));
  await button("新建业务范围").click();
  await input.fill("输入法分类");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await page.waitForTimeout(60);
  assert.equal(await input.isVisible(), true, "IME confirmation must not create a category");
  assert.equal(await page.evaluate(() => window.projectsReview.stores.useProjects.getState().areas.some(value => value.name === "输入法分类")), false);
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", repeat: true });
  await page.waitForTimeout(60);
  assert.equal(await input.isVisible(), true, "Held Enter must not create a category");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.projectsReview.stores.useProjects.getState().areas.some(value => value.name === "输入法分类"));
  // Open another prompt during the preceding close animation. Its content must survive.
  await button("新建业务范围").click(); await input.fill("连续新建"); await page.waitForTimeout(650);
  assert.equal(await input.isVisible(), true); assert.equal(await input.inputValue(), "连续新建");
  await page.keyboard.press("Enter");
  for (const [action, label, value, collection, key] of [["新建项目", "名称", "回车项目", "projects", "name"], ["新建工作项", "标题", "回车工作项", "items", "title"]]) {
    await button(action).first().click(); await dialog().getByRole("textbox", { name: label, exact: true }).fill(value); await page.keyboard.press("Enter");
    await page.waitForFunction(({ collection, key, value }) => window.projectsReview.stores.useProjects.getState()[collection].filter(item => item[key] === value).length === 1, { collection, key, value });
  }
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
    await button("新建迭代").click();
    assert.equal(await button("两周").getAttribute("aria-pressed"), "true");
    assert.equal(await button("两周").getAttribute("data-variant"), "default", "Selected duration must visibly use the primary style");
    const start = page.getByLabel("开始日期", { exact: true }), end = page.getByLabel("结束日期", { exact: true });
    const initialEnd = await end.inputValue();
    await button("三周").click(); assert.equal(await button("三周").getAttribute("aria-pressed"), "true"); assert.notEqual(await end.inputValue(), initialEnd);
    await button("自定义").click(); await end.fill("2026-12-25"); assert.equal(await start.inputValue() !== "", true);
    await dialog().getByRole("textbox", { name: "名称", exact: true }).fill(`键盘迭代-${theme}`); await page.keyboard.press("Enter");
    await page.waitForFunction(value => window.projectsReview.stores.useProjects.getState().iterations.some(item => item.name === value && item.end === "2026-12-25"), `键盘迭代-${theme}`);
    await button("编辑迭代").click();
    assert.equal(await button("自定义").getAttribute("aria-pressed"), "true");
    assert.equal(await end.inputValue(), "2026-12-25", "Editing a saved custom iteration must keep its date range");
    await dialog().getByRole("button", { name: "取消", exact: true }).click();
  }
  assert.deepEqual(errors, []); console.log("PASS category focus, Enter, IME, repeat, fast reopen; project/task Enter; visible two-week default and custom dates in both themes");
} finally { await browser.close(); }
