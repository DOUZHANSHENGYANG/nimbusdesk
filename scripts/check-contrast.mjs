/**
 * 主题配色对比度校验（WCAG AA）。
 *
 * 为什么要有这个脚本：颜色是最容易"改坏却看不出来"的东西 ——
 * 深色模式下某个次要文字掉到 3:1 时，页面看起来仍然"正常"，
 * 只有盯着读很久才会觉得累。把口径写成断言，改 token 时立刻能发现。
 *
 * 校验对象是**实际写进 tokens.css 的取值**，因此这里从 CSS 解析，
 * 而不是在脚本里另抄一份 —— 抄一份就必然漂移。
 *
 * 用法：node scripts/check-contrast.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CSS = readFileSync(join(ROOT, "src/styles/tokens.css"), "utf8");

/* ── OKLCH → sRGB ─────────────────────────────────────── */

function oklchToLinearSrgb(L, C, Hdeg) {
  const H = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  return [
    4.0767416621 * l_ ** 3 - 3.3077115913 * m_ ** 3 + 0.2309699292 * s_ ** 3,
    -1.2684380046 * l_ ** 3 + 2.6097574011 * m_ ** 3 - 0.3413193965 * s_ ** 3,
    -0.0041960863 * l_ ** 3 - 0.7034186147 * m_ ** 3 + 1.707614701 * s_ ** 3,
  ];
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function luminance([L, C, H]) {
  const [r, g, b] = oklchToLinearSrgb(L, C, H).map(clamp01);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** oklch(L C H) 或 oklch(L C H / a)。带 alpha 的按"叠在给定底色上"复合 */
function parseOklch(str) {
  const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)/.exec(str);
  if (!m) return null;
  return {
    L: Number(m[1]),
    C: Number(m[2]),
    H: Number(m[3]),
    a: m[4] === undefined ? 1 : Number(m[4]),
  };
}

/** 半透明色复合到不透明底色上（近似：在 OKLab 空间按 alpha 线性插值） */
function composite(fg, bg) {
  if (fg.a >= 1) return [fg.L, fg.C, fg.H];
  const t = fg.a;
  // OKLCH 不是线性空间，但 L 与 alpha 的插值在这里足够精确（误差 < 0.5% 对比度）
  return [fg.L * t + bg.L * (1 - t), fg.C * t + bg.C * (1 - t), fg.H];
}

function contrast(fgStr, bgStr) {
  const fgRaw = parseOklch(fgStr);
  const bgRaw = parseOklch(bgStr);
  if (!fgRaw || !bgRaw) throw new Error(`无法解析: ${fgStr} / ${bgStr}`);
  const bg = [bgRaw.L, bgRaw.C, bgRaw.H];
  const fg = composite(fgRaw, bgRaw);
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/* ── 从 tokens.css 解析出变量（按 :root / .dark 分段）─── */

/** 把 CSS 按 `:root {` / `.dark {` 分块，收集块内所有 `--name: value;` */
function collectVars(css) {
  const map = { light: new Map(), dark: new Map() };
  // 用花括号配平切块
  const blocks = [];
  const re = /(^|\n)\s*(:root|\.dark)\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    const scope = m[2] === ".dark" ? "dark" : "light";
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    blocks.push({ scope, body: css.slice(re.lastIndex, i - 1) });
  }
  for (const { scope, body } of blocks) {
    for (const v of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      map[scope].set(v[1], v[2].trim());
    }
  }
  return map;
}

const V = collectVars(CSS);

/** 解析变量引用链（`var(--x)` → 实际取值） */
function resolve(name, scope, seen = new Set()) {
  if (seen.has(name)) throw new Error(`变量循环引用: ${name}`);
  seen.add(name);
  const raw = V[scope].get(name) ?? V.light.get(name);
  if (!raw) throw new Error(`未定义变量: ${name}（scope=${scope}）`);
  const varRef = /^var\((--[\w-]+)\)$/.exec(raw);
  if (varRef) return resolve(varRef[1], scope, seen);
  return raw;
}

/* ── 断言表 ───────────────────────────────────────────── */

/** [描述, 前景变量, 背景变量, 最低对比度] */
const CASES = [
  // 浅色
  ["浅色·正文 on 页面底", "--foreground", "--background", 4.5],
  ["浅色·正文 on 卡片", "--card-foreground", "--card", 4.5],
  ["浅色·次要文字 on 页面底", "--muted-foreground", "--background", 4.5],
  ["浅色·次要文字 on 卡片", "--muted-foreground", "--card", 4.5],
  ["浅色·主按钮文字", "--primary-foreground", "--primary", 4.5],
  ["浅色·强调文字 on 强调底", "--accent-foreground", "--accent", 4.5],
  ["浅色·侧栏文字", "--sidebar-foreground", "--sidebar", 4.5],
  ["浅色·侧栏选中文字", "--sidebar-accent-foreground", "--sidebar", 4.5],
  ["浅色·危险色 on 卡片", "--destructive", "--card", 4.5],
  ["浅色·成功色 on 卡片", "--success", "--card", 4.5],
  ["浅色·警告色 on 卡片", "--warning", "--card", 4.5],
  ["浅色·信息色 on 卡片", "--info", "--card", 4.5],
  // 深色
  ["深色·正文 on 页面底", "--foreground", "--background", 4.5],
  ["深色·正文 on 卡片", "--card-foreground", "--card", 4.5],
  ["深色·次要文字 on 页面底", "--muted-foreground", "--background", 4.5],
  ["深色·次要文字 on 卡片", "--muted-foreground", "--card", 4.5],
  ["深色·主按钮文字", "--primary-foreground", "--primary", 4.5],
  ["深色·强调文字 on 强调底", "--accent-foreground", "--card", 4.5],
  ["深色·侧栏文字", "--sidebar-foreground", "--sidebar", 4.5],
  ["深色·侧栏选中文字", "--sidebar-accent-foreground", "--sidebar", 4.5],
  ["深色·危险色 on 卡片", "--destructive", "--card", 4.5],
  ["深色·成功色 on 卡片", "--success", "--card", 4.5],
  ["深色·警告色 on 卡片", "--warning", "--card", 4.5],
  ["深色·信息色 on 卡片", "--info", "--card", 4.5],
];

/*
 * 文件类型色的三项几何约束。
 *
 * 为什么值得固化成断言：这几个数改一个就会破坏整体，而破坏方式很隐蔽 ——
 * 初版把 image 放在 320°，按「紫族 270–310」判定它安全，
 * 但它渲染成 #8e479d，**肉眼就是紫色**。所以紫族的判定上界扩到 348°（含品红），
 * 并与品牌色一起算「安全带」。
 */
const TYPE_HUES = [
  ["pdf", "PDF", 20],
  ["slide", "演示", 49],
  ["archive", "压缩包", 78],
  ["sheet", "表格", 107],
  ["video", "视频", 136],
  ["doc", "文档", 165],
  ["image", "图片", 194],
  ["audio", "音频", 350],
];
const BRAND_HUE = 248; // --pr-brand-600 的色相
const PURPLE_LO = 270;
const PURPLE_HI = 348; // 紫 → 品红
const MIN_SEP = 28; // 类别两两最小环距
const MIN_BRAND = 26; // 与品牌色的最小环距

const hueGap = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

const FILE_KEYS = ["pdf", "slide", "archive", "sheet", "video", "doc", "image", "audio", "misc"];

let pass = 0;
let fail = 0;

console.log("════ 文件类型色相几何约束 ════════════════");
{
  let worst = { gap: 999, pair: "" };
  for (let i = 0; i < TYPE_HUES.length; i++) {
    for (let j = i + 1; j < TYPE_HUES.length; j++) {
      const g = hueGap(TYPE_HUES[i][2], TYPE_HUES[j][2]);
      if (g < worst.gap) worst = { gap: g, pair: `${TYPE_HUES[i][1]}×${TYPE_HUES[j][1]}` };
    }
  }
  const inPurple = TYPE_HUES.filter(([, , h]) => h >= PURPLE_LO && h <= PURPLE_HI);
  let nearest = { gap: 999, name: "" };
  for (const [, label, h] of TYPE_HUES) {
    const g = hueGap(h, BRAND_HUE);
    if (g < nearest.gap) nearest = { gap: g, name: label };
  }

  const results = [
    [worst.gap >= MIN_SEP, `类别两两 ≥${MIN_SEP}°：最小 ${worst.gap}°（${worst.pair}）`],
    [inPurple.length === 0, `避开 ${PURPLE_LO}–${PURPLE_HI}° 紫族：越界 ${inPurple.length} 项`],
    [
      nearest.gap >= MIN_BRAND,
      `距品牌 ${BRAND_HUE}° ≥${MIN_BRAND}°：最近 ${nearest.gap}°（${nearest.name}）`,
    ],
  ];
  for (const [okFlag, msg] of results) {
    okFlag ? pass++ : fail++;
    console.log(`${okFlag ? "OK  " : "FAIL"} ${msg}`);
  }
}

console.log("\n════ 文件类型色对比度（图形，需 ≥3:1）════");
for (const scope of ["light", "dark"]) {
  const label = scope === "light" ? "浅色" : "深色";
  for (const name of FILE_KEYS) {
    const c = contrast(resolve(`--pr-file-${name}`, scope), resolve("--card", scope));
    const okFlag = c >= 3;
    okFlag ? pass++ : fail++;
    console.log(`${okFlag ? "OK  " : "FAIL"} ${c.toFixed(2).padStart(5)}/3.0  ${label}·${name}`);
  }
}

console.log("\n════ 语义色对比度（正文，需 ≥4.5:1）══════");
for (const [desc, fg, bg, need] of CASES) {
  const scope = desc.startsWith("深色") ? "dark" : "light";
  const c = contrast(resolve(fg, scope), resolve(bg, scope));
  const okFlag = c >= need;
  okFlag ? pass++ : fail++;
  console.log(`${okFlag ? "OK  " : "FAIL"} ${c.toFixed(2).padStart(5)}/${need}  ${desc}`);
}

console.log(
  `\n${fail === 0 ? "✓ 配色全部满足 WCAG AA" : `✗ ${fail} 项未达标`}：${pass} 通过 / ${fail} 失败`,
);
process.exit(fail ? 1 : 0);
