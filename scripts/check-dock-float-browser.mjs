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
  const calls = window.__dockFloat.calls.filter(
    (call) => call.cmd === "dock_spring_box" || call.cmd === "dock_spring_to",
  );
  if (!calls.length) return null;
  const a = calls[calls.length - 1].args;
  return { x: a.toX, y: a.toY, width: a.toW, height: a.toH };
});

try {
  await page.goto(`${process.env.FIXTURE_ORIGIN ?? "http://127.0.0.1:17800"}/src/features/desktop/fixtures/dock-float.html`);
  await page.locator(".df-capsule").waitFor();
  // 胶囊有 180ms 的入场缩放（0.96 → 1）；不等动画结束就量，四舍五入会得到 42。
  await page.waitForTimeout(260);

  // ① 胶囊：44 高、水平居中、五个直达图标 + 展开箭头
  const capsule = await page.locator(".df-capsule").boundingBox();
  assert.equal(Math.round(capsule.height), 44, "胶囊必须 44 高");
  assert.equal(Math.round(capsule.width), 464, "胶囊铺满 464 宽的窗口");
  assert.ok(Math.abs(capsule.x) <= 1, "胶囊铺满窗口（窗口自己负责居中）");
  assert.equal(await page.locator(".df-quick-btn").count(), 5, "胶囊只放主标签 5 个");
  const startBounds = await lastBounds();
  assert.equal(startBounds.height, 44, "启动时窗口就该是胶囊高度");

  // ② 展开：卡片与窗口一起变成 660×591
  await page.getByRole("button", { name: "展开卡片" }).click();
  await page.locator(".df-card").waitFor();
  // 主标签 5 个 + 次标签 1 个；胶囊快捷图标仍必须是 6 个（防止再改错位置）
  assert.equal(await page.locator(".df-tabs .df-tab").count(), 5, "主标签 5 个");
    await page.setViewportSize({ width: 660, height: 591 });
  await page.waitForTimeout(80);
  // 量布局尺寸：撑开动画用 transform 缩放，boundingBox 会量到中间帧
  const card = await page.locator(".df-card").evaluate((el) => ({ width: el.offsetWidth, height: el.offsetHeight }));
  assert.equal(Math.round(card.width), 660, "卡片布局宽 660");
  // 表面形变：最终相位 + 禁用 scale + clip-path 已到全开
  await page.waitForFunction(
    () => document.querySelector(".df-root")?.getAttribute("data-phase") === "expanded",
    undefined,
    { timeout: 3000 },
  );
  const surface = await page.locator(".df-card").evaluate((el) => {
    const style = getComputedStyle(el);
    return { transform: style.transform, clipPath: style.clipPath };
  });
  assert.equal(surface.transform, "none", "展开不能再用 scale 伪造尺寸");
  assert.ok(surface.clipPath.includes("inset"), "展开必须走 clip-path 形变");
  assert.equal(await page.locator(".df-head").evaluate((el) => getComputedStyle(el).display), "grid", "头部用三组网格");
  assert.equal(await page.locator(".df-tools .df-icon-btn").count(), 4, "工具组只放 4 个内容工具");
  assert.equal(await page.locator(".df-window-actions .df-icon-btn").count(), 3, "窗口操作组放 AI/设置/收起");
  const tabWidths = await page.locator(".df-tab").evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().width)));
  assert.equal(new Set(tabWidths).size, 1, "五个主标签必须严格等宽");
  assert.equal(await page.locator(".df-head").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true, "头部三组不能溢出");
  const expanded = await lastBounds();
  assert.equal(expanded.width, 660, "展开后窗口宽 660");
  assert.equal(expanded.height, 591, "展开后窗口高 591");
  assert.equal(expanded.x, Math.round((1360 - 660) / 2), "展开时水平居中（工作区 1360 宽）");
  // 胶囊不再卸载，而是淡出让位（保留节点才能让形状连续）
  assert.equal(
    await page.locator(".df-capsule").evaluate((node) => getComputedStyle(node).opacity),
    "0",
    "展开后胶囊淡出",
  );

  // ③ 五个主标签：都能切，且卡片尺寸不变
  for (const name of ["搜索", "收纳盒", "计划", "项目", "资讯"]) {
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

  // ⑤b 日历：react-day-picker 固定 6 周，点日期列当天条目；切月高度不变
  await page.getByRole("button", { name: "日历", exact: true }).click();
  await page.locator(".df-calendar").waitFor();
  assert.equal(await page.locator(".df-calpicker-weekday").count(), 7, "日历要有 7 个星期表头");
  assert.equal(await page.locator(".df-calpicker-cell").count(), 42, "fixedWeeks 固定 42 格");
  assert.ok(await page.locator(".df-calpicker-dot").count() >= 1, "有任务的日子要有圆点");
  assert.equal(await page.locator(".df-calendar-row").count(), 5, "今天应列出 5 条计划（含子任务）");
  const calendarBefore = await page.locator(".df-calpicker").boundingBox();
  assert.ok(calendarBefore, "日历必须渲染");
  await page.getByRole("button", { name: "下个月" }).click();
  await page.waitForTimeout(120);
  assert.equal(await page.locator(".df-calpicker-cell").count(), 42, "切月后仍是 42 格");
  const calendarAfter = await page.locator(".df-calpicker").boundingBox();
  assert.ok(calendarAfter && Math.abs(calendarAfter.height - calendarBefore.height) <= 1, "切月份日历高度不变");
  assert.equal((await lastBounds()).height, 591, "日历页卡片高度仍是 591");

  // ⑥ 资讯页：来源混排
  await page.getByRole("tab", { name: "资讯", exact: true }).click();
  assert.equal(await page.locator(".df-news-row").count(), 3, "夹具里三条资讯都要出现");

  // ⑥b 通知页：未授权只有一支可点击的提示；授权后按应用名/时间列出系统通知
  await page.getByRole("button", { name: "通知", exact: true }).click();
  await page.locator("[data-notice-permission]").waitFor();
  assert.equal(await page.locator(".df-notice-section").count(), 2, "通知页必须分成云台提醒 / 系统通知两段");
  assert.equal(await page.locator("[data-notice-permission]").count(), 1, "未授权时系统段只有一个授权提示");
  assert.ok((await page.locator("[data-notice-permission]").innerText()).includes("去设置授权"), "授权提示要写清楚动作");
  await page.locator("[data-notice-permission]").click();
  assert.equal(await page.evaluate(() => window.__dockFloat.calls.some((call) => call.cmd === "open_notification_settings")), true, "点授权提示要打开设置页");

  await page.evaluate(() => {
    window.__dockFloat.systemSnapshot = {
      access: "allowed",
      detail: null,
      items: [{ id: 7, appName: "微信", title: "新消息", body: "今晚一起吃饭", createdAt: new Date().toISOString() }],
    };
  });
  await page.getByRole("tab", { name: "资讯", exact: true }).click();
  await page.getByRole("button", { name: "通知", exact: true }).click();
  await page.locator(".df-notice-sys").waitFor();
  assert.equal(await page.locator(".df-notice-sys").count(), 1, "授权后要列出系统通知");
  const systemText = await page.locator(".df-notice-sys").innerText();
  assert.ok(systemText.includes("微信") && systemText.includes("新消息"), "系统通知要带应用名和标题");

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
  await page.waitForTimeout(1000);
  assert.equal(await page.locator(".df-root").getAttribute("data-phase"), "compact", "收起后相位必须回到 compact");
  const collapsed = await lastBounds();
  assert.equal(collapsed.height, 44, "收起后窗口回到胶囊高度");
  assert.equal(collapsed.width, 464, "收起后窗口宽 464");

  assert.deepEqual(errors, [], "不许有页面异常");
  console.log("OK   capsule 44 → card 660×591 → six tabs（含收纳盒/计划/项目本体）→ settings → collapse");
} finally {
  await browser.close();
}
