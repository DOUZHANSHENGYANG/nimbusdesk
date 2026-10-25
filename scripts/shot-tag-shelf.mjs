import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const dir = "E:/01-Desktop/仙台/工作台软件/docs/screenshots";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto("http://127.0.0.1:17800/src/ahub/fixtures/tag-shelf.html");
  // 等真内容出现再截：Vite 改完文件后第一次编译可能超过固定等待
  await page.getByRole("button", { name: "批量选择" }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${dir}/tag-shelf.png` });

  // 页签：标签（不是弹窗）
  await page.getByRole("button", { name: /^标签/ }).first().click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${dir}/tag-manager.png` });

  // 回到技能页，⌘K 检索面板
  await page.getByRole("button", { name: /^技能/ }).first().click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="tag-shelf-command"]').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/tag-command.png` });

  console.log("errors", errors);
} finally {
  await browser.close();
}
