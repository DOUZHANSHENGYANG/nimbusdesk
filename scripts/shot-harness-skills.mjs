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
  await page.locator("#overview").screenshot({ path: `${dir}/harness-overview.png` });
  await page.locator("#skills").screenshot({ path: `${dir}/harness-skills.png` });
  console.log("errors", errors);
} finally {
  await browser.close();
}
