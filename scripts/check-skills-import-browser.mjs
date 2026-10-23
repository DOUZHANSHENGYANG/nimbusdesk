import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(`${process.env.ZENTAO_FIXTURE_ORIGIN ?? "http://127.0.0.1:17800"}/src/ahub/fixtures/skills.html`);
  await page.getByRole("button", { name: "添加技能", exact: true }).waitFor();

  // 主界面不再有「批量导入」那条虚线拖放条，也不再有第二个导入入口。
  assert.equal(await page.getByText("拖到这里批量导入", { exact: false }).count(), 0, "Batch-import strip must be gone from the skills page");
  assert.equal(await page.getByRole("button", { name: "批量导入", exact: true }).count(), 0, "The separate import button must be gone too");

  // 导入能力挪进「添加技能 → 从文件导入」：两张卡本身就是落点。
  await page.getByRole("button", { name: "添加技能", exact: true }).click();
  await page.getByRole("button", { name: /从文件导入/ }).click();
  await page.waitForSelector('[data-drop-slot="folder"]');
  assert.equal(await page.locator('[data-drop-slot="folder"]').count(), 1);
  assert.equal(await page.locator('[data-drop-slot="zip"]').count(), 1);
  const folderText = await page.locator('[data-drop-slot="folder"]').innerText();
  const zipText = await page.locator('[data-drop-slot="zip"]').innerText();
  assert.equal(folderText.includes("把技能文件夹拖到这里"), true, "Folder card must say it accepts drops");
  assert.equal(zipText.includes("把 .zip 拖到这里"), true, "ZIP card must say it accepts drops");
  assert.equal(zipText.includes("不支持 rar"), true, "ZIP card must keep the rar warning that used to live on the strip");
  assert.equal(await page.getByRole("button", { name: "选择文件夹并导入", exact: false }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "选择 ZIP 并导入", exact: false }).count(), 1);

  assert.deepEqual(errors, []);
  console.log("PASS skills import: main-page strip and its button are gone, the two cards inside 添加技能 → 从文件导入 are the drop targets");
} finally { await browser.close(); }
