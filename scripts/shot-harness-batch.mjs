import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const dir = "E:/01-Desktop/仙台/工作台软件/docs/screenshots";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto("http://127.0.0.1:17800/src/ahub/fixtures/tag-shelf.html");
  await page.getByRole("button", { name: "批量选择" }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "批量选择" }).click();
  await page.getByRole("button", { name: "全选当前" }).click();
  await page.getByRole("button", { name: "接入工具", exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/harness-batch.png` });

  // 移出方向：同一批技能，看看每个工具下有多少副本可移
  await page.getByRole("button", { name: "移出", exact: true }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/harness-batch-remove.png` });

  // 空态：三条入口
  await page.goto("http://127.0.0.1:17800/src/ahub/fixtures/tag-shelf.html?empty=1");
  await page.getByText("还没有技能").waitFor({ timeout: 20000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/tag-empty.png` });

  console.log("errors", errors);
} finally {
  await browser.close();
}
