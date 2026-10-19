import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";
import { mkdir } from "node:fs/promises";

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const url = `${process.env.ZENTAO_FIXTURE_ORIGIN ?? "http://127.0.0.1:17800"}/src/features/projects/fixtures/zentao.html`;
const checks = [];
async function check(label, action) { await action(); checks.push(label); console.log(`PASS ${label}`); }
const button = name => page.getByRole("button", { name, exact: true });
const dialog = () => page.getByRole("dialog");
const flush = () => page.evaluate(() => window.zenReview.flush());
async function openPanel() { await button("禅道连接").click(); await dialog().waitFor(); }
async function closePanel() { await dialog().getByRole("button", { name: "关闭", exact: true }).click(); await dialog().waitFor({ state: "hidden" }); }
async function configure(name, version) {
  await button("新建连接").click();
  await page.getByLabel("连接名称", { exact: true }).fill(name);
  await page.getByLabel("禅道地址", { exact: true }).fill(`https://${version}.example.test/zentao/`);
  await page.getByLabel("账号", { exact: true }).fill("fixture-user");
  await page.getByRole("combobox", { name: "API 版本", exact: true }).click();
  await page.getByRole("option", { name: `API ${version}`, exact: true }).click();
  await button("保存配置").click(); await flush();
}
try {
  await page.goto(url);
  await button("禅道连接").waitFor();
  await check("drafts require no company credentials or network access", async () => {
    await openPanel(); await button("新建连接").click();
    await page.getByLabel("连接名称", { exact: true }).fill("稍后配置"); await button("保存配置").click();
    await flush();
    assert.equal(await button("立即同步").isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.zenReview.calls.filter(call => ["zentao_fetch_tasks", "zentao_test_connection"].includes(call.cmd))), []);
    assert.equal(await page.evaluate(() => window.zenReview.stores.useZentao.getState().connections[0].autoSync), false);
  });
  await check("multiple connections and transient secret clearing", async () => {
    await configure("公司 v1", "v1");
    await page.getByLabel("密码（仅本次输入）", { exact: true }).fill("FIXTURE_SECRET_NO_JSON");
    await closePanel(); await openPanel();
    assert.equal(await page.getByLabel("密码（仅本次输入）", { exact: true }).inputValue(), "");
    await page.getByRole("combobox", { name: "禅道连接", exact: true }).click();
    await page.getByRole("option", { name: "公司 v1", exact: true }).click();
    await page.getByLabel("密码（仅本次输入）", { exact: true }).fill("FIXTURE_SECRET_NO_JSON");
    await button("验证并保存凭据").click(); await page.getByText("本机已保存凭据", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("密码（仅本次输入）", { exact: true }).inputValue(), "");
    await flush();
    assert.equal(await page.evaluate(() => JSON.stringify(window.zenReview.fixtures).includes("FIXTURE_SECRET_NO_JSON")), false);
  });
  await check("background sync can close, imports idempotently and locks identity", async () => {
    await page.evaluate(() => { window.zenReview.hold = true; });
    await button("立即同步").click(); await page.getByText("同步在后台继续，可以关闭此窗口。", { exact: true }).waitFor();
    await closePanel(); await button("禅道连接").filter({ hasText: "正在同步…" }).waitFor();
    await page.evaluate(() => window.zenReview.release());
    await button("禅道连接").filter({ hasText: "禅道连接" }).waitFor(); await openPanel();
    await page.getByRole("combobox", { name: "禅道连接", exact: true }).click(); await page.getByRole("option", { name: "公司 v1", exact: true }).click();
    assert.equal(await page.getByLabel("禅道地址", { exact: true }).isDisabled(), true);
    await button("立即同步").click(); await button("立即同步").waitFor();
    await page.waitForFunction(() => !Object.values(window.zenReview.stores.useZentao.getState().syncStates).some(s => s.lastError));
    assert.equal(await page.evaluate(() => window.zenReview.stores.useProjects.getState().remoteTasks.length), 1);
    await mkdir("Temp/zentao-ui", { recursive: true });
    await page.screenshot({ path: "Temp/zentao-ui/zentao-panel-dark.png", animations: "disabled", style: "[data-sonner-toaster] { visibility: hidden !important; }" });
  });
  await check("v2 instance keeps same remote ID distinct", async () => {
    await configure("公司 v2", "v2");
    await page.getByLabel("Token（仅本次输入）", { exact: true }).fill("FIXTURE_TOKEN_NO_JSON");
    await button("验证并保存凭据").click(); await page.getByText("本机已保存凭据", { exact: true }).waitFor();
    await button("立即同步").click();
    await page.waitForFunction(() => window.zenReview.stores.useProjects.getState().remoteTasks.length === 2);
    await flush();
    assert.equal(await page.evaluate(() => new Set(window.zenReview.stores.useProjects.getState().remoteTasks.map(task => task.id)).size), 2);
    assert.equal(await page.evaluate(() => JSON.stringify(window.zenReview.fixtures).includes("FIXTURE_TOKEN_NO_JSON")), false);
  });
  await check("partial snapshot failure and inaccessible task retain cache, retry recovers", async () => {
    await page.evaluate(() => { window.zenReview.fetchError = "ZenTao request failed on a later page."; });
    await button("立即同步").click(); await button("重试同步").waitFor();
    assert.equal(await page.evaluate(() => window.zenReview.stores.useProjects.getState().remoteTasks.length), 2);
    await page.evaluate(() => { window.zenReview.fetchError = null; window.zenReview.unavailable = true; });
    await button("重试同步").click(); await page.waitForFunction(() => Object.values(window.zenReview.stores.useZentao.getState().syncStates).some(state => state.lastError?.includes("暂不可访问")));
    assert.equal(await page.evaluate(() => window.zenReview.stores.useProjects.getState().remoteTasks.length), 2);
    await page.evaluate(() => { window.zenReview.unavailable = false; });
    await button("重试同步").click(); await button("立即同步").waitFor();
    await closePanel();
  });
  await check("synced unplanned tasks remain discoverable from current-iteration filters", async () => {
    await page.locator('[data-zen-unplanned-hint]').waitFor();
    await button("查看已同步待排期").click();
    assert.equal(await page.locator('[data-work-item]').count(), 2);
    assert.equal(await page.locator('[data-zen-unplanned-hint]').count(), 0);
    await page.getByRole("combobox", { name: "迭代", exact: true }).click();
    await page.getByRole("option", { name: "当前迭代 · 当前迭代", exact: true }).click();
  });
  await check("explicit merge preview, default local values and active/archive/history retention", async () => {
    await page.locator('[data-work-item="local-task"] button[aria-pressed]').click();
    await button("关联禅道").click();
    await page.getByLabel("搜索标题、任务 ID 或连接名称…", { exact: true }).fill("123");
    await dialog().getByRole("button", { name: /禅道采购任务.*公司 v1/ }).click();
    await page.locator('[data-zen-merge-preview]').waitFor();
    assert.equal(await page.getByRole("radio", { name: /保留当前值/ }).count(), 4);
    assert.equal(await dialog().locator("img").count(), 0, "Remote descriptions must remain untrusted text");
    const donorId = await page.evaluate(() => { const s = window.zenReview.stores.useProjects.getState(); return s.remoteLinks.find(link => s.remoteTasks.find(task => task.id === link.id)?.connectionId === window.zenReview.stores.useZentao.getState().connections.find(c => c.name === "公司 v1").id).itemId; });
    await page.evaluate(donor => {
      const { useProjects, usePlans, usePlansArchive } = window.zenReview.stores;
      usePlans.setState(s => ({ days: { ...s.days, "2026-10-10": [{ id: "donor-plan", title: "来源计划", parentId: null, workItemId: donor, done: false, createdAt: 2, updatedAt: 2 }] } }));
      usePlansArchive.setState(s => ({ days: { ...s.days, "2026-10-09": { archivedAt: 2, tasks: [{ id: "donor-archive", title: "来源归档计划", parentId: null, workItemId: donor, done: true, createdAt: 2, updatedAt: 2 }] } } }));
      useProjects.getState().updateItem(donor, { title: "来源工作项本地改名", note: "来源工作项独有备注", status: "todo", deadline: "2026-11-10" });
      useProjects.setState(s => ({ memberships: [...s.memberships, { id: "donor-history", itemId: donor, iterationId: "iteration-old", joinedAt: 1, leftAt: 2, carriedFrom: null, updatedAt: 2, snapshot: { title: "来源历史", status: "todo", deadline: null } }] }));
    }, donorId);
    const donorComparison = page.locator('[data-zen-donor-differences]');
    await donorComparison.getByText("来源工作项独有备注", { exact: true }).waitFor();
    assert.equal(await donorComparison.getByRole("row").count(), 5);
    assert.equal(await donorComparison.getByRole("cell", { name: "2026-11-10", exact: true }).count(), 1);
    assert.equal(await donorComparison.locator("img").count(), 0);
    await page.screenshot({ path: "Temp/zentao-ui/zentao-merge-dark.png", animations: "disabled", style: "[data-sonner-toaster] { visibility: hidden !important; }" });
    await button("确认合并并关联").click(); await dialog().waitFor({ state: "hidden" }); await flush();
    const result = await page.evaluate(donor => { const { useProjects, usePlans, usePlansArchive } = window.zenReview.stores; const s = useProjects.getState(); return { title: s.items.find(i => i.id === "local-task").title, donor: s.items.find(i => i.id === donor), active: Object.values(usePlans.getState().days).flat().find(t => t.id === "donor-plan").workItemId, archived: Object.values(usePlansArchive.getState().days).flatMap(day => day.tasks).find(t => t.id === "donor-archive").workItemId, history: s.memberships.filter(m => m.itemId === "local-task").length }; }, donorId);
    assert.equal(result.title, "本地采购任务"); assert.equal(result.donor.mergedIntoId, "local-task"); assert.equal(result.donor.note, "来源工作项独有备注"); assert.equal(result.active, "local-task"); assert.equal(result.archived, "local-task"); assert.ok(result.history >= 2);
    await page.getByRole("button", { name: "在浏览器打开来源", exact: true }).waitFor();
    await page.getByRole("button", { name: "在浏览器打开来源", exact: true }).click();
    const sourceCall = await page.evaluate(() => window.zenReview.calls.findLast(call => call.cmd.includes("open_url")));
    assert.equal(sourceCall.args.url, "https://v1.example.test/zentao/task-view-123.html");
  });
  await check("merged record exposes the donor original values without editing", async () => {
    await page.getByRole("combobox", { name: "迭代", exact: true }).click();
    await page.getByRole("option", { name: "全部迭代", exact: true }).click();
    const donorId = await page.evaluate(() => window.zenReview.stores.useProjects.getState().items.find(item => item.mergedIntoId === "local-task").id);
    await page.locator(`[data-work-item="${donorId}"] button[aria-pressed]`).click();
    const details = page.getByRole("complementary", { name: "工作项详情", exact: true });
    await details.getByText("来源工作项独有备注", { exact: true }).waitFor();
    assert.equal(await details.getByText("状态 · 待办", { exact: true }).count(), 1);
    assert.equal(await details.getByText("截止日期 · 2026-11-10", { exact: true }).count(), 1);
    assert.equal(await details.getByRole("button", { name: "编辑工作项", exact: true }).count(), 0);
  });
  await check("deleting a tested draft forgets device credentials first", async () => {
    await openPanel(); await configure("临时验证连接", "v2");
    await page.getByLabel("密码（仅本次输入）", { exact: true }).fill("TRANSIENT_DELETE_SECRET");
    await button("验证并保存凭据").click(); await page.getByText("本机已保存凭据", { exact: true }).waitFor();
    const id = await page.evaluate(() => window.zenReview.stores.useZentao.getState().connections.find(c => c.name === "临时验证连接").id);
    await button("删除连接草稿").click();
    await page.waitForFunction(id => !window.zenReview.stores.useZentao.getState().connections.some(c => c.id === id), id);
    await flush();
    const result = await page.evaluate(id => { const calls = window.zenReview.calls; return { forget: calls.findIndex(call => call.cmd === "zentao_forget_secret" && call.args.connectionId === id), removal: calls.findLastIndex(call => call.cmd === "write_json" && call.args.key === "zentao" && !call.args.value.state.connections.some(c => c.id === id)), leaked: JSON.stringify(window.zenReview.fixtures).includes("TRANSIENT_DELETE_SECRET") }; }, id);
    assert.ok(result.forget >= 0 && result.removal > result.forget); assert.equal(result.leaked, false);
    await closePanel();
  });
  await check("keyboard escape returns focus and narrow/light layouts fit", async () => {
    await openPanel(); await page.keyboard.press("Escape"); await dialog().waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("button", { name: "禅道连接", exact: true }).evaluate(el => el === document.activeElement), true);
    await page.setViewportSize({ width: 390, height: 844 }); await openPanel();
    assert.ok(await dialog().evaluate(el => el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().right <= innerWidth));
    await page.evaluate(() => { document.documentElement.classList.remove("dark"); });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await mkdir("Temp/zentao-ui", { recursive: true }); await page.screenshot({ path: "Temp/zentao-ui/zentao-light-narrow.png", fullPage: true, animations: "disabled", style: "[data-sonner-toaster] { visibility: hidden !important; }" });
  });
  assert.deepEqual(errors, []);
  console.log(`${checks.length} ZenTao browser checks passed; mocked native boundary, no live company authentication.`);
} catch (error) {
  console.error(await page.locator("body").innerText().catch(() => "Could not read page"));
  console.error("Browser errors:", errors); throw error;
} finally { await browser.close(); }
