import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const dir = "E:/01-Desktop/仙台/工作台软件/docs/screenshots";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 880, height: 620 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto("http://127.0.0.1:17800/src/features/plans/fixtures/plan-outline.html");
  await page.getByRole("button", { name: /对齐导出模板/ }).first().click();
  await page.getByRole("dialog", { name: "任务详情" }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/plan-outline-detail.png` });
  console.log("errors", errors);
} finally {
  await browser.close();
}
