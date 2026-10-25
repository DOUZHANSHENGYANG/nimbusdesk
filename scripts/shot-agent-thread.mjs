import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const dir = "E:/01-Desktop/仙台/工作台软件/docs/screenshots";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 860 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto("http://127.0.0.1:17800/src/features/agent/fixtures/agent-thread.html");
  await page.getByText("今日安排").waitFor({ timeout: 20000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/agent-markdown.png` });

  // 悬停用户消息，露出「回退到这里」
  await page.getByText("帮我把今天的安排整理一下").hover();
  await page.waitForTimeout(300);
  const revert = page.getByTitle("回退到这里");
  await revert.waitFor({ timeout: 5000 });
  await page.screenshot({ path: `${dir}/agent-revert.png` });

  // 点一下：消息应被截断，原文回到输入框
  await revert.click();
  await page.waitForTimeout(300);
  const input = await page.locator(".agent-composer textarea").inputValue();
  console.log("composer", JSON.stringify(input));
  console.log("assistant-gone", await page.getByText("今日安排").count());
  console.log("errors", errors);
} finally {
  await browser.close();
}
