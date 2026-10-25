import { mkdirSync } from "node:fs";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";

const dir = "E:/01-Desktop/仙台/工作台软件/design-demos/tag-shelf";
const shots = `${dir}/shots`;
mkdirSync(shots, { recursive: true });

const files = [
  ["A-卡片仓.html", "A-卡片仓.png"],
  ["B-检索优先.html", "B-检索优先.png"],
  ["C-治理台.html", "C-治理台.png"],
];

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

for (const [file, out] of files) {
  await page.goto(`file:///${dir}/${encodeURIComponent(file)}`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/${out}` });
  console.log("shot", out);
}

console.log("errors", errors);
await browser.close();
