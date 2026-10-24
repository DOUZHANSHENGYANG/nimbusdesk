import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

/**
 * 胶囊 Dock 的浏览器回归：夹具是「真组件 + mock 原生 IPC」。
 *
 * 断言全部落在用户能看见 / 窗口会真的变的地方：
 *   胶囊 44 高且水平居中 → 展开后窗口 660×591 → 五个页都能切且尺寸不变 →
 *   齿轮带 route 跳主窗口 → 收起回到 44 高。
 * 尺寸断言读的是 mock 到的 window_set_bounds 参数，不是 CSS —— 窗口矩形由 Rust 改，
 * 只量 DOM 会把「CSS 长得对、窗口没变」这种回退放过去。
 */
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
// 视口 = 窗口：真机上窗口矩形由 Rust 改，夹具里用 setViewportSize 模拟同一步。
const page = await browser.newPage({ viewport: { width: 464, height: 44 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

// 展开/收起现在走 dock_spring_box（四元组弹簧）；断言它的目标值。
const lastBounds = () => page.evaluate(() => {
  const calls = window.__dockFloat.calls.filter((call) => call.cmd === "dock_spring_box");
  if (!calls.length) return null;
  const a = calls[calls.length - 1].args;
  return { x: a.toX, y: a.toY, width: a.toW, height: a.toH };
});

try {
  await page.goto(`${process.env.FIXTURE_ORIGIN ?? "http://127.0.0.1:17800"}/src/features/desktop/fixtures/dock-float.html`);
  await page.locator(".df-capsule").waitFor();

  // ① 胶囊：44 高、水平居中、五个直达图标 + 展开箭头
  const capsule = await page.locator(".df-capsule").boundingBox();
  assert.equal(Math.round(capsule.height), 44, "胶囊必须 44 高");
  assert.equal(Math.round(capsule.width), 464, "胶囊铺满 464 宽的窗口");
  assert.ok(Math.abs(capsule.x) <= 1, "胶囊铺满窗口（窗口自己负责居中）");
  assert.equal(await page.locator(".df-quick-btn").count(), 6, "六个 tab 都要有直达入口");
  const startBounds = await lastBounds();
  assert.equal(startBounds.height, 44, "启动时窗口就该是胶囊高度");

  // ② 展开：卡片与窗口一起变成 660×591
  await page.getByRole("button", { name: "展开卡片" }).click();
  await page.locator(".df-card").waitFor();
  await page.setViewportSize({ width: 660, height: 591 });
  await page.waitForTimeout(80);
  const card = await page.locator(".df-card").boundingBox();
  assert.equal(Math.round(card.width), 660, "卡片宽 660");
  const expanded = await lastBounds();
  assert.equal(expanded.width, 660, "展开后窗口宽 660");
  assert.equal(expanded.height, 591, "展开后窗口高 591");
  assert.equal(expanded.x, Math.round((1360 - 660) / 2), "展开时水平居中（工作区 1360 宽）");
  assert.equal(await page.locator(".df-capsule").count(), 0, "展开后胶囊不在");

  // ③ 五个页：都能切，且卡片尺寸不变
  for (const name of ["搜索", "收纳盒", "计划", "项目", "收集", "资讯"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await page.waitForTimeout(80);
    assert.equal(await page.getByRole("tab", { name, exact: true }).getAttribute("aria-selected"), "true", `${name} 必须选中`);
    const box = await page.locator(".df-card").boundingBox();
    assert.equal(Math.round(box.width), 660, `切到 ${name} 后卡片宽度不变`);
    const height = await lastBounds();
    assert.equal(height.height, 591, `切到 ${name} 后窗口高度不变`);
  }

  // ④ 三个真面板：收纳盒 / 计划 / 项目 必须是侧栏那套组件本体，不是卡片里重写的
  await page.getByRole("tab", { name: "收纳盒", exact: true }).click();
  assert.equal(await page.locator('.df-host .dock-panel-input[placeholder="搜索条目标题…"]').count(), 1, "收纳盒必须是侧栏那个 FencesFlyout 本体");
  await page.getByRole("tab", { name: "计划", exact: true }).click();
  assert.ok(await page.locator(".df-host .dock-todo").count() >= 1, "计划要列出今日待办");
  await page.getByRole("tab", { name: "项目", exact: true }).click();
  assert.ok(await page.locator(".df-host .dock-pname").count() >= 1, "项目要列出在办项目");

  // ⑥ 资讯页：来源混排
  await page.getByRole("tab", { name: "资讯", exact: true }).click();
  assert.equal(await page.locator(".df-news-row").count(), 3, "夹具里三条资讯都要出现");

  // ⑦ 齿轮：唯一跳主窗口的入口
  await page.getByRole("button", { name: "设置（打开主窗口）" }).click();
  const opened = await page.evaluate(() => window.__dockFloat.calls.filter((call) => call.cmd === "desktop_open_main").at(-1));
  assert.equal(opened.args.route, "/settings", "齿轮必须跳设置页");

  // ⑦b AI 对话是副页：点星标进、返回键出
  await page.getByRole("button", { name: "AI 对话" }).click();
  await page.locator(".df-chat-list").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "返回列表" }).click();
  await page.locator(".df-tabs").waitFor({ state: "visible" });

  // ⑧ 收起：窗口回到 44 高
  await page.getByRole("button", { name: "收起卡片" }).click();
  await page.locator(".df-capsule").waitFor();
  await page.setViewportSize({ width: 464, height: 44 });
  await page.waitForTimeout(80);
  const collapsed = await lastBounds();
  assert.equal(collapsed.height, 44, "收起后窗口回到胶囊高度");
  assert.equal(collapsed.width, 464, "收起后窗口宽 464");

  assert.deepEqual(errors, [], "不许有页面异常");
  console.log("OK   capsule 44 → card 660×591 → six tabs（含收纳盒/计划/项目本体）→ settings → collapse");
} finally {
  await browser.close();
}
