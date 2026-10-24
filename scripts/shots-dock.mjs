import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

/**
 * 生成 docs/screenshots 里胶囊 Dock 的截图。
 *
 * 用的是和回归同一套夹具（真组件 + mock 原生 IPC），所以截图里的数据、
 * 密度、字体都是真机的样子，只是窗口尺寸由 setViewportSize 模拟。
 * 改了胶囊的外观就重跑一次，别拿旧图当文档。
 */
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 464, height: 44 }, deviceScaleFactor: 2 });
const shot = async (name) => {
  await page.locator(".df-card").screenshot({ path: `docs/screenshots/${name}.png` });
  console.log("saved", name);
};

try {
  await page.goto(`${process.env.FIXTURE_ORIGIN ?? "http://127.0.0.1:17800"}/src/features/desktop/fixtures/dock-float.html`);
  await page.locator(".df-capsule").waitFor();
  await page.locator(".df-capsule").screenshot({ path: "docs/screenshots/dock-capsule.png" });
  await page.getByRole("button", { name: "展开" }).click();
  await page.setViewportSize({ width: 660, height: 591 });
  await page.locator(".df-card").waitFor();

  await page.getByRole("tab", { name: "搜索", exact: true }).click();
  await shot("dock-capsule-search");
  await page.getByRole("tab", { name: "收纳盒", exact: true }).click();
  await shot("dock-capsule-fences");
  await page.getByRole("tab", { name: "资讯", exact: true }).click();
  await shot("dock-capsule-news");
  const first = page.locator(".df-news-open").first();
  if (await first.count()) { await first.click(); await shot("dock-capsule-news-reader"); }
  await page.getByRole("button", { name: "AI 对话" }).click();
  await shot("dock-capsule-chat");
} finally {
  await browser.close();
}
