#!/usr/bin/env node
/**
 * GitHub 仓库页回归：token 门 → 三列表 → README 抽屉 → 划词翻译 → 置顶 → 下载 → 关联项目。
 *
 * 前置：`npm run dev`（Vite 在 17800），夹具 `src/features/projects/fixtures/github.html`
 *       （夹具自带 mock IPC，plugin-http 也走 mock，不联网）。
 * 用法：`node scripts/check-github-browser.mjs`
 *
 * 断言：
 *   1. 我的仓库列出 4 条，fork 标 2 条、归档标 1 条；
 *   2. 已 star 页签只列 star 快照；今日热榜解析出 3 条并带「今日新增」；
 *   3. 点仓库打开 README 抽屉并渲染 markdown；
 *   4. 拖选 README 一段 → 出现「翻译」按钮 → 点完出译文（走 mock 的免费翻译端点）；
 *   5. 置顶把该仓库顶到第一行；
 *   6. 下载落到默认下载目录，对话框回显保存路径；
 *   7. 关联本地项目后行上出现项目名徽标；
 *   8. 没有 token 时只出连接卡片，不发 GitHub 请求；
 *   9. 全程无运行时错误。
 */
import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const ORIGIN = process.env.FIXTURE_ORIGIN ?? "http://127.0.0.1:17800";
const FIXTURE = `${ORIGIN}/src/features/projects/fixtures/github.html`;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const rows = () => page.locator("[data-github-repo]");
const tab = (name) => page.getByRole("button", { name: new RegExp(name) });
const rangeText = () => page.evaluate(() => {
  const selection = window.getSelection();
  return selection && selection.rangeCount ? selection.getRangeAt(0).toString() : "";
});

try {
  await page.goto(FIXTURE, { waitUntil: "networkidle" });
  await rows().first().waitFor({ timeout: 10000 });

  // 1. 我的仓库：4 条，fork 2 条，归档 1 条
  assert.equal(await rows().count(), 4, "my repositories should list every repo the token owns");
  assert.equal(await page.locator("[data-github-fork]").count(), 2, "forked repos must be marked");
  assert.equal(await page.locator("[data-github-archived]").count(), 1, "archived repos must be marked");
  await page.screenshot({ path: "docs/screenshots/project-management-github-list.png" });

  // 2. 已 star 与热榜
  await tab("已 star").click();
  await rows().first().waitFor();
  assert.equal(await rows().count(), 1, "starred tab must show the star snapshot");

  await tab("今日热榜").click();
  await rows().first().waitFor();
  assert.equal(await rows().count(), 3, "trending parser should yield three rows");
  assert.match(await rows().first().innerText(), /\+1,723/, "trending rows carry stars gained in the window");

  // 3. README
  await tab("我的仓库").click();
  await rows().first().locator("button").first().click();
  const drawer = page.locator(".md-body");
  await drawer.waitFor({ timeout: 10000 });
  assert.match(await drawer.innerText(), /Why/, "README markdown should render as content, not raw text");
  assert.match(await drawer.innerText(), /Offline first/, "list items should render");

  // 4. 划词翻译：拖选一段才有选区（body 默认不可选，README 容器必须放行）
  const target = page.locator(".md-body p").filter({ hasText: "local-first" }).first();
  const box = await target.boundingBox();
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 6, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  assert.match(await rangeText(), /local-first/, "dragging over a README paragraph should select it");

  const translate = page.getByRole("button", { name: "翻译" });
  await translate.waitFor({ timeout: 5000 });
  await translate.click();
  await page.getByText("一个用 Tauri 和 React 构建的本地优先工作台。").waitFor({ timeout: 5000 });
  await page.screenshot({ path: "docs/screenshots/project-management-github-readme.png" });
  // Esc 现在会直接关掉 README 抽屉（与项目页一致），所以用它来关，不再找关闭按钮
  await page.keyboard.press("Escape");
  await page.locator(".md-body").waitFor({ state: "detached", timeout: 5000 });

  // 5. 置顶：第二条顶到第一行
  const second = rows().nth(1);
  const secondName = await second.locator("span.truncate").first().innerText();
  await second.hover();
  await second.getByRole("button", { name: /^置顶/ }).click();
  await page.waitForTimeout(100);
  assert.equal(await rows().first().locator("span.truncate").first().innerText(), secondName, "pinning must move the repo to the top");

  // 6. 下载：默认目录来自系统下载目录，保存路径回显
  const first = rows().first();
  await first.hover();
  await first.locator("[data-github-download]").click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 5000 });
  assert.match(await dialog.innerText(), /E:\/Downloads/, "the dialog must show the default download folder");
  await dialog.getByRole("button", { name: "下载源码包", exact: true }).click();
  await page.getByText(/oil-ui-main\.zip/).waitFor({ timeout: 5000 });
  await dialog.getByRole("button", { name: "关闭" }).click();

  // 7. 关联本地项目：一个仓库可挂多个项目，行上出现项目徽标与 +N
  await first.hover();
  await first.locator("[data-github-link]").click();
  const linkDialog = page.getByRole("dialog");
  await linkDialog.getByRole("button", { name: "云台工作台", exact: true }).click();
  await linkDialog.getByRole("button", { name: "本地副本", exact: true }).click();
  const badge = page.locator("[data-github-linked]").first();
  await badge.waitFor({ timeout: 5000 });
  assert.equal(await badge.innerText(), "云台工作台", "a linked repo must show its first local project");
  const more = page.locator("[data-github-linked-more]").first();
  await more.waitFor({ timeout: 5000 });
  assert.equal(await more.innerText(), "+1", "a repo linked to several projects must show the overflow count");
  await page.screenshot({ path: "docs/screenshots/project-management-github-actions.png" });

  // 8. 翻页：第一页满 100 条就继续取第二页，短页即停
  await page.goto(`${FIXTURE}?paged=1`, { waitUntil: "networkidle" });
  await page.getByText("dz/tail-repo").waitFor({ timeout: 10000 });
  assert.equal(await rows().count(), 101, "a full first page must be followed by the second page");
  const pages = await page.evaluate(() => window.githubReview.http.filter(entry => entry.url.includes("/user/repos")).map(entry => new URL(entry.url).searchParams.get("page")));
  assert.deepEqual(pages, ["1", "2"], "paging must stop after the short page");

  // 9. 上游变化：消失的仓库保留条目并提示，fork 丢掉 parent 标「上游已删除」
  await page.goto(`${FIXTURE}?gone=1`, { waitUntil: "networkidle" });
  const banner = page.locator("[data-github-missing-banner]");
  await banner.waitFor({ timeout: 10000 });
  assert.match(await banner.innerText(), /^1 个仓库已从 GitHub 消失/, "a vanished repo must be announced");
  const goneRows = page.locator("[data-github-missing]");
  assert.equal(await goneRows.count(), 1, "the vanished repo keeps one entry");
  assert.match(await goneRows.first().innerText(), /dz\/ghost/, "the entry names the vanished repo");
  assert.equal(await page.locator("[data-github-parent-missing]").count(), 1, "a fork without parent means its upstream is gone");
  await page.getByText(/这些仓库已从 GitHub 消失：dz\/ghost/).waitFor({ timeout: 5000 });
  await page.screenshot({ path: "docs/screenshots/project-management-github-upstream-gone.png" });
  await goneRows.first().getByRole("button", { name: /移除条目/ }).click();
  assert.equal(await page.locator("[data-github-missing]").count(), 0, "dismissing removes the stale entry");

  // 9. 缓存优先：网络被挂住时，先用上次快照铺屏；放行后再换成最新数据
  await page.goto(`${FIXTURE}?cached=1&hold=1`, { waitUntil: "domcontentloaded" });
  const cachedRow = page.locator('[data-github-repo="dz/nimbus-desk"]');
  await cachedRow.waitFor({ timeout: 15000 });
  // 请求已发出但都还挂在闸门上（held>0）：说明行是缓存画出来的，不是等回包
  assert.ok(await page.evaluate(() => window.githubReview.held.length > 0), "cached rows must render before any response arrives");
  await cachedRow.locator("button").first().click();
  await page.getByText("缓存里的 README").waitFor({ timeout: 5000 });
  await page.evaluate(() => window.githubReview.releaseAll());
  await page.locator(".md-body h1", { hasText: "nimbus-desk" }).waitFor({ timeout: 8000 });

  // 10. star 写入失败要回滚：夹具让 PUT/DELETE 返回 500
  await page.goto(`${FIXTURE}?starfail=1`, { waitUntil: "networkidle" });
  await rows().first().waitFor();
  const firstRow = rows().first();
  await firstRow.hover();
  const starButton = firstRow.getByRole("button", { name: /^取消 star/ });
  assert.equal(await starButton.getAttribute("aria-pressed"), "true", "the fixture starts with the repo starred");
  await starButton.click();
  await page.waitForTimeout(400);
  assert.equal(await starButton.getAttribute("aria-pressed"), "true", "a failed star write must roll back");

  // 11. 没有 token 时：主界面就地给一个 token 输入框，不发任何 GitHub 请求
  await page.goto(`${FIXTURE}?token=none`, { waitUntil: "networkidle" });
  const field = page.locator("#github-token");
  await field.waitFor({ timeout: 5000 });
  assert.equal(await field.getAttribute("placeholder"), "GitHub token", "the empty state offers the token field in place");
  assert.ok(await page.getByRole("button", { name: "保存" }).isVisible(), "the save action sits next to the field");
  assert.ok(!(await page.evaluate(() => window.githubReview.http.some(entry => entry.url.includes("api.github.com/user")))), "no GitHub request without a token");
  await page.screenshot({ path: "docs/screenshots/project-management-github-connect.png" });

  assert.deepEqual(errors, [], "the page must not raise runtime errors");
  console.log("github page: repos/fork/archived, star snapshot, trending, readme, selection translate, pin, download, project link — ok");
} finally {
  await browser.close();
}
