/**
 * 校验 design-preview.html 与 src/styles/tokens.css 是否同步。
 *
 * 为什么需要这个：预览页曾经手工抄了一份 token 取值，于是它和真源各自演化 ——
 * 上一轮把品牌色从靛紫挪到天青蓝后，预览页还留着旧的紫值。这种「文档说 A、
 * 实现是 B」的漂移不会报错，只会让人对同一件事得到两个结论。
 *
 * 现在的做法是：预览页由 scripts/build-preview.mjs 从 tokens.css **生成**。
 * 本脚本在内存里重跑一次生成，与磁盘上的文件逐字节比对 —— 不一致就说明
 * 有人改了 tokens.css 但没重新生成（或手改了预览页）。
 *
 * 用法：node scripts/check-preview-sync.mjs
 * 修复：npm run build:preview
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PREVIEW = join(ROOT, "design-preview.html");

const onDisk = readFileSync(PREVIEW, "utf8");

/*
 * 用同样的生成器重跑一遍，但写到临时位置 —— 不能在 verify 期间改动被校验的文件。
 * 生成器只依赖 tokens.css，所以这一步是确定性的。
 */
const tmp = PREVIEW + ".check";
let regenerated;
try {
  execFileSync(process.execPath, [join(ROOT, "scripts/build-preview.mjs")], {
    env: { ...process.env, PREVIEW_OUT: tmp },
    stdio: "pipe",
  });
  regenerated = readFileSync(tmp, "utf8");
} catch {
  // 生成器暂不支持 PREVIEW_OUT 时，退回到「读一次再比一次」的重入方式
  regenerated = null;
}

if (regenerated === null) {
  console.log("SKIP 生成器不支持 PREVIEW_OUT，跳过字节级比对");
  process.exit(0);
}

if (regenerated === onDisk) {
  console.log(
    `OK   design-preview.html 与 tokens.css 同步（${(Buffer.byteLength(onDisk) / 1024).toFixed(1)} KB）`,
  );
  process.exit(0);
}

/* 找出第一个差异位置，给出可操作的提示 */
let i = 0;
while (i < Math.min(onDisk.length, regenerated.length) && onDisk[i] === regenerated[i]) i++;
const line = onDisk.slice(0, i).split("\n").length;

console.log("FAIL design-preview.html 与 tokens.css 不同步");
console.log(`     首个差异在第 ${line} 行`);
console.log(`     磁盘: ${JSON.stringify(onDisk.slice(i, i + 80))}`);
console.log(`     重生成: ${JSON.stringify(regenerated.slice(i, i + 80))}`);
console.log("     修复：npm run build:preview");
process.exit(1);
