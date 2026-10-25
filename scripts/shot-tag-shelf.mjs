import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto("http://127.0.0.1:17800/src/ahub/fixtures/tag-shelf.html");
  await page.waitForSelector("text=标签仓库", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "E:/01-Desktop/仙台/工作台软件/docs/screenshots/tag-shelf.png" });
  console.log("errors", errors);
} finally {
  await browser.close();
}
