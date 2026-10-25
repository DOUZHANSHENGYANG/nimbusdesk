import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const dir = "E:/01-Desktop/仙台/工作台软件/docs/screenshots";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 980 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto("http://127.0.0.1:17800/src/ahub/fixtures/harness-skills.html");
  await page.getByText("Claude Code").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(700);
  await page.locator("#tools").screenshot({ path: `${dir}/harness-tools.png` });
  await page.locator("#overview").screenshot({ path: `${dir}/harness-overview.png` });
  await page.locator("#skills").screenshot({ path: `${dir}/harness-skills.png` });

  // 迁移弹窗：Claude Code 的官方环境变量入口
  await page.getByRole("button", { name: "迁移", exact: true }).first().click();
  await page.getByText("迁移 Claude Code 到其他盘").waitFor({ timeout: 5000 });
  await page.screenshot({ path: `${dir}/harness-migrate.png` });
  console.log("errors", errors);
} finally {
  await browser.close();
}
