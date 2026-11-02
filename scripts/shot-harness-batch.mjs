import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

/**
 * 按工具接入 / 移出的截图（技能页）与冒烟。
 *
 * 接入现在在「扫描本机」弹框里：`HarnessDialog` 两个页签 —— 从本机收集 / 应用到工具；
 * 移出则走列表的「批量删除」，在二次确认里勾「同时从工具移出副本」。
 * 旧脚本走的是更早的独立批量弹框（先点「批量选择」再「全选当前」→「接入工具」/「移出」），
 * 那条路 36c2e55 就没了 —— 脚本一直跑不起来，这一版按现在的界面重写。
 */
const dir = "E:/01-Desktop/仙台/工作台软件/docs/screenshots";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto("http://127.0.0.1:17800/src/ahub/fixtures/tag-shelf.html");
  const scanButton = page.getByRole("button", { name: "扫描本机" }).first();
  await scanButton.waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);

  // 接入方向：扫描本机弹框 → 应用到本机 → 全选 → 每个工具一行「应用」
  await scanButton.click();
  const dialog = page.locator('[role="dialog"]').first();
  await dialog.getByRole("heading", { name: "本机 AI Skills" }).waitFor({ timeout: 15000 });
  await dialog.getByRole("tab", { name: "应用到本机" }).click();
  await dialog.getByRole("button", { name: "全选", exact: true }).first().click();
  const selected = await dialog.getByText(/^已选 \d+ \/ \d+$/).innerText();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/harness-batch.png` });

  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: 5000 });

  // 移出方向：全选卡片 → 批量删除 → 二次确认里「同时从工具移出副本」
  await page.getByRole("button", { name: "全选所有" }).click();
  await page.getByRole("button", { name: "批量删除" }).click();
  const removeDialog = page.locator('[role="dialog"]').first();
  await removeDialog.getByRole("heading", { name: "删除技能" }).waitFor({ timeout: 10000 });
  const removeCopy = removeDialog.getByLabel(/同时从工具移出副本/);
  await removeCopy.waitFor({ timeout: 5000 });
  const checkedByDefault = await removeCopy.isChecked();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/harness-batch-remove.png` });

  console.log(JSON.stringify({ selected, checkedByDefault, errors }));
} finally {
  await browser.close();
}
