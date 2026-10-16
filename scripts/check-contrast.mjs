/**
 * 主题配色校验（WCAG AA + 色相几何）。
 *
 * 为什么要有这个脚本：颜色是最容易「改坏却看不出来」的东西 ——
 * 深色模式下某个次要文字掉到 3:1 时，页面看起来仍然「正常」，
 * 只有盯着读很久才会觉得累。把口径写成断言，改 token 时立刻能发现。
 *
 * 校验对象是**实际写进 tokens.css 的取值**，因此这里从 CSS 解析，
 * 而不是在脚本里另抄一份 —— 抄一份就必然漂移。
 *
 * 关键修正（第一版有 bug）：
 *   文件类型色的色相约束必须算在**渲染后 sRGB 色相**上，不是 oklch 的第三参数。
 *   旧版 audio 写 oklch(0.52 0.15 350)，按「避开 270–348」判定安全通过；
 *   但它渲染出来是 #a53c75，sRGB 色相 327.4° —— 人眼看到的正是紫色。
 *   校验口径与感知不一致，等于没校验。现在两者分别断言。
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
const encode = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);

function luminance([L, C, H]) {
  const [r, g, b] = oklchToLinearSrgb(L, C, H).map(clamp01);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function toHex(L, C, H) {
  return (
    "#" +
    oklchToLinearSrgb(L, C, H)
      .map(encode)
      .map(clamp01)
      .map((v) => Math.round(v * 255).toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * 渲染后色相（浮点 sRGB，不经过 8bit 量化）。
 *
 * 这是人眼真正看到的色相。oklch 的 H 与它并不相等：
 * oklch(0.52 0.15 350) 的 H=350，渲染色相却是 327°。
 * 用 8bit 量化过的值算会因舍入把相邻色相压成同一个数，所以走浮点。
 */
function renderedHue(L, C, H) {
  const [r, g, b] = oklchToLinearSrgb(L, C, H).map(encode).map(clamp01);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d < 1e-9) return -1; // 无彩：色相无意义
  const h = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return (h + 360) % 360;
}

/** oklch(L C H) 或 oklch(L C H / a)。带 alpha 的按「叠在给定底色上」复合 */
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
  // 这个最紧：muted-foreground 也常出现在 muted/secondary 底上（下拉项、标签）
  ["浅色·次要文字 on muted 底", "--muted-foreground", "--muted", 4.5],
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
  ["深色·次要文字 on muted 底", "--muted-foreground", "--muted", 4.5],
  ["深色·主按钮文字", "--primary-foreground", "--primary", 4.5],
  ["深色·强调文字 on 卡片", "--accent-foreground", "--card", 4.5],
  ["深色·侧栏文字", "--sidebar-foreground", "--sidebar", 4.5],
  ["深色·侧栏选中文字", "--sidebar-accent-foreground", "--sidebar", 4.5],
  ["深色·危险色 on 卡片", "--destructive", "--card", 4.5],
  ["深色·成功色 on 卡片", "--success", "--card", 4.5],
  ["深色·警告色 on 卡片", "--warning", "--card", 4.5],
  ["深色·信息色 on 卡片", "--info", "--card", 4.5],
];

/*
 * 文件类型色的几何约束。
 *
 * 三重口径（全部在**渲染后色相**上）：
 *   1. 禁止区 265–350°：紫 → 品红。这是用户明确反感的「AI 味」。
 *   2. 与品牌色渲染色相（≈207°）留 ≥20° 缓冲，且不得落在蓝紫侧，
 *      否则「图片/文档」图标会被读成品牌强调元素。
 *   3. 类别两两 ≥22°（16px 图标下仍可辨别）。
 *
 * 为什么这些数字值得固化成断言：改一个就会破坏整体，而破坏方式很隐蔽 ——
 * 初版把 audio 放在 oklch H=350，判定「350 不在 270–348 内」通过，
 * 但渲染出来 327.4°，是紫色。所以必须双口径校验。
 */
const TYPE_KEYS = ["pdf", "slide", "archive", "sheet", "video", "doc", "image", "audio"];
const TYPE_LABELS = {
  pdf: "PDF",
  slide: "演示",
  archive: "压缩包",
  sheet: "表格",
  video: "视频",
  doc: "文档",
  image: "图片",
  audio: "音频",
};
const PURPLE_LO = 265;
const PURPLE_HI = 350;
const MIN_SEP = 22; // 类别两两最小环距（渲染色相）
const MIN_BRAND = 20; // 与品牌渲染色相的最小环距

const hueGap = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

let pass = 0;
let fail = 0;

console.log("════ 中性色「真无彩」检查 ═══════════════");
{
  // 灰阶必须 C=0。只要 C>0，大面积铺开就会泛出彩调（这就是上一版发蓝/发紫的根源）。
  const grayKeys = [...V.light.keys()].filter((k) => /^--pr-gray-/.test(k));
  const tinted = grayKeys.filter((k) => {
    const p = parseOklch(V.light.get(k));
    return p && p.C > 0;
  });
  const okFlag = tinted.length === 0;
  okFlag ? pass++ : fail++;
  console.log(
    `${okFlag ? "OK  " : "FAIL"} ${grayKeys.length} 个灰阶全部 C=0` +
      (okFlag ? "" : `：${tinted.map((k) => `${k}=${V.light.get(k)}`).join(", ")}`),
  );
}

console.log("\n════ 文件类型色相几何约束 ════════════════");
{
  // 浅色档与深色档都必须合法
  const rows = TYPE_KEYS.map((k) => {
    const l = parseOklch(resolve(`--pr-file-${k}`, "light"));
    const d = parseOklch(resolve(`--pr-file-${k}`, "dark"));
    return {
      key: k,
      label: TYPE_LABELS[k],
      lightHue: renderedHue(l.L, l.C, l.H),
      darkHue: renderedHue(d.L, d.C, d.H),
      lightHex: toHex(l.L, l.C, l.H),
      darkHex: toHex(d.L, d.C, d.H),
    };
  });

  const brandLight = (() => {
    const p = parseOklch(resolve("--pr-brand-600", "light"));
    return renderedHue(p.L, p.C, p.H);
  })();
  const brandDark = (() => {
    const p = parseOklch(resolve("--pr-brand-400", "dark"));
    return renderedHue(p.L, p.C, p.H);
  })();

  const inPurpleL = rows.filter((r) => r.lightHue >= PURPLE_LO && r.lightHue <= PURPLE_HI);
  const inPurpleD = rows.filter((r) => r.darkHue >= PURPLE_LO && r.darkHue <= PURPLE_HI);

  let worstL = { gap: 999, pair: "" };
  let worstD = { gap: 999, pair: "" };
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const gl = hueGap(rows[i].lightHue, rows[j].lightHue);
      const gd = hueGap(rows[i].darkHue, rows[j].darkHue);
      if (gl < worstL.gap) worstL = { gap: gl, pair: `${rows[i].label}×${rows[j].label}` };
      if (gd < worstD.gap) worstD = { gap: gd, pair: `${rows[i].label}×${rows[j].label}` };
    }
  }
  const nearestBrandL = rows.reduce(
    (acc, r) => (hueGap(r.lightHue, brandLight) < acc.gap ? { gap: hueGap(r.lightHue, brandLight), r } : acc),
    { gap: 999, r: null },
  );
  const nearestBrandD = rows.reduce(
    (acc, r) => (hueGap(r.darkHue, brandDark) < acc.gap ? { gap: hueGap(r.darkHue, brandDark), r } : acc),
    { gap: 999, r: null },
  );
  // 蓝紫侧越界：渲染色相落在品牌与紫区之间（品牌 ~207 到 265）
  const blueViolet = rows.filter((r) => r.lightHue > brandLight && r.lightHue < PURPLE_LO);

  const results = [
    [inPurpleL.length === 0, `浅色档避开 ${PURPLE_LO}–${PURPLE_HI}° 紫族：越界 ${inPurpleL.length} 项`],
    [inPurpleD.length === 0, `深色档避开 ${PURPLE_LO}–${PURPLE_HI}° 紫族：越界 ${inPurpleD.length} 项`],
    [blueViolet.length === 0, `不落品牌↔紫区的蓝紫带（${brandLight.toFixed(0)}–${PURPLE_LO}°）：越界 ${blueViolet.length} 项`],
    [worstL.gap >= MIN_SEP, `浅色两两 ≥${MIN_SEP}°：最小 ${worstL.gap.toFixed(1)}°（${worstL.pair}）`],
    [worstD.gap >= MIN_SEP, `深色两两 ≥${MIN_SEP}°：最小 ${worstD.gap.toFixed(1)}°（${worstD.pair}）`],
    [
      nearestBrandL.gap >= MIN_BRAND,
      `浅色距品牌 ${brandLight.toFixed(0)}° ≥${MIN_BRAND}°：最近 ${nearestBrandL.gap.toFixed(1)}°（${nearestBrandL.r?.label}）`,
    ],
    [
      nearestBrandD.gap >= MIN_BRAND,
      `深色距品牌 ${brandDark.toFixed(0)}° ≥${MIN_BRAND}°：最近 ${nearestBrandD.gap.toFixed(1)}°（${nearestBrandD.r?.label}）`,
    ],
  ];
  for (const [okFlag, msg] of results) {
    okFlag ? pass++ : fail++;
    console.log(`${okFlag ? "OK  " : "FAIL"} ${msg}`);
  }

  console.log("\n  语义      浅色(渲染H)          深色(渲染H)");
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(6)}  ${r.lightHex} ${r.lightHue.toFixed(1).padStart(6)}°   ${r.darkHex} ${r.darkHue
        .toFixed(1)
        .padStart(6)}°`,
    );
  }
}

console.log("\n════ 文件类型色对比度（图形，需 ≥3:1）════");
for (const scope of ["light", "dark"]) {
  const label = scope === "light" ? "浅色" : "深色";
  for (const name of [...TYPE_KEYS, "misc"]) {
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
