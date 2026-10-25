import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const dir = "E:/01-Desktop/仙台/工作台软件/docs/screenshots";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto("http://127.0.0.1:17800/src/ahub/fixtures/mcp-prompts.html");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${dir}/mcp-rail.png` });

  await page.locator('[data-fixture="prompts"]').click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${dir}/prompts-rail.png` });

  console.log("errors", errors);
} finally {
  await browser.close();
}
