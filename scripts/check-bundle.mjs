#!/usr/bin/env node
/**
 * 分包体检：看「任何一个窗口一打开就必须解析」的那批 chunk 有多大。
 *
 * 为什么专门查这个：这个应用在 Windows 上**每个窗口都是一个独立 WebView2 进程**
 * （主窗口、Dock、每个文件栅栏、每张待办纸片、右键菜单浮窗、采集窗、搜索窗…），
 * 它们加载的是同一份 `index.html`。所以入口的静态闭包越大，小窗口就越亏 ——
 * 一个几十行的右键菜单也要解析整份应用。
 *
 * 用它验收分包改动：
 *   npm run build && npm run check:bundle
 *
 * 判定：静态闭包 > 900 KB 或其中出现 AI SDK 的痕迹，就说明又有东西被拖进公共路径了。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.argv[2] ?? process.cwd();
const DIST = path.join(ROOT, "dist");
const ASSETS = path.join(DIST, "assets");
const LIMIT_KB = 900;

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("dist/index.html 不存在 —— 先跑 npm run build");
  process.exit(1);
}

const kb = (file) => Math.round(fs.statSync(path.join(ASSETS, file)).size / 1024);
const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
const entry = [...html.matchAll(/<script[^>]*type="module"[^>]*src="\/assets\/([^"]+)"/g)].map((m) => m[1]);

/** entry 的静态 import 闭包 = 任何窗口首屏必然解析的代码。 */
const seen = new Set();
const stack = [...entry];
while (stack.length) {
  const file = stack.pop();
  if (!seen.has(file)) {
    seen.add(file);
    const code = fs.readFileSync(path.join(ASSETS, file), "utf8");
    for (const m of code.matchAll(/(?:from|import)\s*"\.\/([A-Za-z0-9_.-]+\.js)"/g)) {
      if (!seen.has(m[1])) stack.push(m[1]);
    }
  }
}

const rows = [...seen].map((file) => [file, kb(file)]).sort((a, b) => b[1] - a[1]);
const total = rows.reduce((sum, [, size]) => sum + size, 0);

console.log(`任一窗口首屏必然加载：${rows.length} 块 / ${total} KB（上限 ${LIMIT_KB} KB）`);
for (const [file, size] of rows.slice(0, 8)) console.log(`  ${file.padEnd(34)}${String(size).padStart(5)} KB`);

const lazy = fs
  .readdirSync(ASSETS)
  .filter((file) => file.endsWith(".js") && !seen.has(file))
  .map((file) => [file, kb(file)])
  .sort((a, b) => b[1] - a[1]);
console.log(`\n按需加载：${lazy.length} 块 / ${lazy.reduce((sum, [, size]) => sum + size, 0)} KB`);
for (const [file, size] of lazy.slice(0, 6)) console.log(`  ${file.padEnd(34)}${String(size).padStart(5)} KB`);

/*
 * AI SDK（`ai` / `@ai-sdk/*` / zod）只该出现在「对话」页那一片里。
 * 它一旦回到入口闭包，说明又有人从公共路径静态 import 了 agent 的东西。
 */
const aiMarkers = ["streamText", "createOpenAICompatible", "languageModelSchema", "toolCallRepair"];
const leaked = rows.filter(([file]) => {
  const code = fs.readFileSync(path.join(ASSETS, file), "utf8");
  return aiMarkers.some((marker) => code.includes(marker));
});

let failed = false;
if (total > LIMIT_KB) {
  console.error(`\n✗ 入口静态闭包 ${total} KB，超过 ${LIMIT_KB} KB：又有依赖被拉进公共路径了。`);
  failed = true;
}
if (leaked.length) {
  console.error(`\n✗ AI SDK 出现在首屏闭包里：${leaked.map(([file]) => file).join(", ")}`);
  failed = true;
}
if (failed) process.exit(1);
console.log(`\n✓ 入口静态闭包 ${total} KB，AI SDK 不在其中`);
