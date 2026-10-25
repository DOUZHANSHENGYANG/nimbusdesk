import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const dir = "E:/01-Desktop/仙台/工作台软件/docs/screenshots";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto("http://127.0.0.1:17800/src/ahub/fixtures/tag-shelf.html");
  await page.waitForTimeout(2200);
  await page.getByText("代码评审", { exact: true }).first().hover();
  await page.getByTitle("删除").first().click();
  await page.getByText("删除技能", { exact: true }).waitFor({ timeout: 5000 });
  const checkbox = page.getByRole("checkbox");
  console.log("checked", await checkbox.isChecked());
  await page.screenshot({ path: `${dir}/skill-delete-harness.png` });
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await page.getByText("技能已删除", { exact: true }).waitFor({ timeout: 5000 });
  const calls = await page.evaluate(() =>
    window.__ahubCalls
      .filter((call) => call.cmd === "remove_from_harness")
      .map((call) => ({ harness: call.args.harness, kind: call.args.kind, names: call.args.names })),
  );
  console.log("removeCalls", JSON.stringify(calls));
  console.log("errors", errors);
} finally {
  await browser.close();
}
