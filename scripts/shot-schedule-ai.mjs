import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const dir = "E:/01-Desktop/仙台/工作台软件/docs/screenshots";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 940 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto("http://127.0.0.1:17800/src/features/schedule/fixtures/editor.html");
  await page.getByRole("button", { name: "新建任务" }).click();
  await page.getByText("用一句话生成").waitFor({ timeout: 10000 });
  await page.getByPlaceholder("例如：每个工作日早上 9 点，把昨天合入的 PR 整理成晨报").fill("每个工作日早上 9 点，把昨天合入的 PR 整理成晨报");
  await page.getByRole("button", { name: "AI 生成" }).click();
  await page.waitForTimeout(600);
  console.log("name", JSON.stringify(await page.locator("#schedule-name").inputValue()));
  console.log("summary", (await page.getByTestId("schedule-summary").innerText()).trim());
  await page.screenshot({ path: `${dir}/schedule-ai.png` });
  console.log("errors", errors);
} finally {
  await browser.close();
}
