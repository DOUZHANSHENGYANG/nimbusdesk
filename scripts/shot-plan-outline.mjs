import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const dir = "E:/01-Desktop/仙台/工作台软件/docs/screenshots";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 620 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto("http://127.0.0.1:17800/src/features/plans/fixtures/plan-outline.html");
  // 静止态 + 悬停态：动作块（把手 / + / ⋯）只在悬停时显形，且都在标题后面
  await page.locator('[data-search-task-id="task-3"]').hover();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/plan-outline-rows.png` });
  // 详情：点标题（或 ⋯）把这一条放到右边那一栏
  await page.locator('[data-search-task-id="task-1"] button[title="打开任务详情"]').click();
  await page.getByRole("complementary", { name: "任务详情" }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/plan-outline-detail.png` });
  console.log("errors", errors);
} finally {
  await browser.close();
}
