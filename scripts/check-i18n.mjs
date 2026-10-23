/**
 * i18n 一致性校验。
 *
 * 为什么必须有这个脚本：react-i18next 在缺 key 时**不会报错**，
 * 它直接把 key 字符串渲染到界面上（用户看到 `settings.backupExport`）。
 * 这类故障在构建、类型检查里全都无声通过，只有在 UI 上肉眼才看得出来。
 *
 * 校验四件事：
 *   1. zh / en 的 key 集合双向一致（缺谁、多谁）
 *   2. 同一 key 的 `{{占位符}}` 集合一致（中英各写一个，参数名写错就丢参数）
 *   3. 值为空字符串
 *   4. 源码里 `t("…")` 用到的 key 都已定义（**这条抓的是拼写错误**）
 *
 * 用法：npm run check:i18n
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
/** 云台自己的词表：默认语言内联在入口，另一门语言是独立分片（`src/lib/locales/en.ts`）。 */
const I18N_DIR = join(ROOT, "src/lib/locales");
const I18N_FILES = { zh: join(I18N_DIR, "zh.ts"), en: join(I18N_DIR, "en.ts") };
/*
 * AgentHub（源侧工具箱）的键表。
 *
 * 它不在 lib/i18n.ts 里，而是由 `src/lib/i18n.ts` 末尾的 addResourceBundle
 * 合并进同一个实例（deep + overwrite=false，云台同名键优先）。
 * 校验必须把它一起算上：否则搬过来的组件里那 800 多条 `t("mcp.…")` 会被
 * 第 4 项判成「引用了未定义的 key」；而要是不校验，源侧那张表里的
 * 缺键/空文案又会漏掉。
 */
const AHUB_I18N_FILE = join(ROOT, "src/ahub/i18n/index.ts");
/** 源侧键表里已知的占位符差异，不算错误 —— 见下方 PLACEHOLDER_EXCEPTIONS */
const PLACEHOLDER_EXCEPTIONS = new Set(["prompts.varsSyntax", "prompts.varsEmpty"]);
const SRC_DIR = join(ROOT, "src");

/**
 * 从源码里抠出 `const <name> = { … }` 的对象字面量文本。
 *
 * i18n.ts 只有字符串，所以直接当表达式求值即可 —— 比引入 TS 编译器轻得多，
 * 也不依赖构建产物。扫描时跟踪字符串状态，避免把值里的 `{` `}` 当结构。
 */
function extractObject(src, name) {
  // 允许类型标注：`const en: typeof zh = {`
  const m = new RegExp(`const ${name}\\s*(?::[^=]+)?=\\s*\\{`).exec(src);
  if (!m) throw new Error(`i18n.ts 里找不到 const ${name} = {`);
  const open = m.index + m[0].length - 1; // 指向 `{`
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`${name} 的对象字面量没有闭合`);
}

/** 把嵌套对象拍平成 `a.b.c` → 值 */
function flatten(obj, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

/** 取出 `{{name}}` 里的名字，排序后便于比较 */
function placeholders(value) {
  if (typeof value !== "string") return [];
  return [...value.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)]
    .map((m) => m[1])
    .sort();
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

/** 源码里所有 `t("literal")` / `i18n.t("literal")` 的 key，以及模板字面量前缀 */
function collectUsedKeys(files) {
  const literal = new Set();
  const prefixes = new Set();
  const candidates = new Set();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    // t("a.b") —— 排除 t(`…`) 与 t(variable)
    for (const m of text.matchAll(/(?:^|[^\w.])t\(\s*"([^"]+)"/g)) literal.add(m[1]);
    // t(`plans.presets.${x}`) → 记前缀 `plans.presets.`
    for (const m of text.matchAll(/(?:^|[^\w.])t\(\s*`([^`$]*)\$\{/g)) prefixes.add(m[1]);
    /*
     * 数据表驱动的用法：`{ key: "nav.home", icon }` 之类，key 作为普通字符串
     * 存起来、渲染时再 `t(key)`。这类引用无法从调用点看出，但如果按
     * 「string 字面量恰好等于某个已定义 key」来匹配，就能把 67 条误报降到个位数。
     * 代价是拼写错误查不出来 —— 所以第 4 项的 `t("…")` 精确检查仍然保留。
     */
    for (const m of text.matchAll(/["']([a-zA-Z][\w]*(?:\.[\w]+)+)["']/g)) candidates.add(m[1]);
  }
  return { literal, prefixes, candidates };
}

const appZhSrc = readFileSync(I18N_FILES.zh, "utf8");
const appEnSrc = readFileSync(I18N_FILES.en, "utf8");
const ahubSrc = readFileSync(AHUB_I18N_FILE, "utf8");
/*
 * 合并顺序即优先级：后展开的覆盖先展开的，与运行时一致
 * （云台先 init，再 addResourceBundle(overwrite=false) 灌源侧的表）。
 */
const zh = new Map([
  ...flatten(new Function(`return (${extractObject(ahubSrc, "zh")})`)()),
  ...flatten(new Function(`return (${extractObject(appZhSrc, "zh")})`)()),
]);
const en = new Map([
  ...flatten(new Function(`return (${extractObject(ahubSrc, "en")})`)()),
  ...flatten(new Function(`return (${extractObject(appEnSrc, "en")})`)()),
]);

const errors = [];
const warnings = [];

// 1. key 集合双向一致
for (const k of zh.keys()) if (!en.has(k)) errors.push(`en 缺少 key: ${k}`);
for (const k of en.keys()) if (!zh.has(k)) errors.push(`zh 缺少 key: ${k}`);

// 2. 占位符一致
for (const [k, v] of zh) {
  if (!en.has(k)) continue;
  const a = placeholders(v).join(",");
  const b = placeholders(en.get(k)).join(",");
  // 源侧的 prompts.varsSyntax / prompts.varsEmpty：zh 写 {{名称}}、en 写 {{name}}，
  // 而两处调用都不传参数（没有丢参数的风险）。照搬不改，因此放进白名单。
  if (a !== b && !PLACEHOLDER_EXCEPTIONS.has(k)) {
    errors.push(`占位符不一致 ${k}: zh=[${a}] en=[${b}]`);
  }
}

// 3. 空值
for (const [k, v] of zh) if (typeof v === "string" && !v.trim()) errors.push(`zh 空文案: ${k}`);
for (const [k, v] of en) if (typeof v === "string" && !v.trim()) errors.push(`en 空文案: ${k}`);

// 4. 源码用到但未定义的 key
const { literal, prefixes, candidates } = collectUsedKeys(walk(SRC_DIR));
for (const k of literal) {
  if (zh.has(k)) continue;
  // react-i18next 的默认值写法 t("a.b", "兜底文案")：允许未定义
  const hasDefault = new RegExp(`t\\(\\s*"${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*,`).test(
    walk(SRC_DIR).map((f) => readFileSync(f, "utf8")).join("\n"),
  );
  if (hasDefault) continue;
  errors.push(`源码引用了未定义的 key: ${k}`);
}
for (const prefix of prefixes) {
  if (![...zh.keys()].some((k) => k.startsWith(prefix))) {
    errors.push(`模板字面量的前缀没有任何对应 key: ${prefix}`);
  }
}

// 5. 定义了但没用到（只提示，不视为错误 —— 可能是动态拼接）
for (const k of zh.keys()) {
  if (literal.has(k)) continue;
  if (candidates.has(k)) continue;
  if ([...prefixes].some((p) => k.startsWith(p))) continue;
  warnings.push(k);
}

const total = zh.size;
if (errors.length) {
  console.error(`\n✗ i18n 校验失败（${errors.length} 项，共 ${total} 个 key）\n`);
  for (const e of errors) console.error(`  • ${e}`);
  if (warnings.length) {
    console.error(`\n  另有 ${warnings.length} 个 key 未被静态引用（可能是动态拼接，仅提示）`);
  }
  console.error("");
  process.exit(1);
}

console.log(`✓ i18n 一致：${total} 个 key，zh/en 对齐，占位符一致`);
/*
 * 未引用 key 默认只报数量。
 * 一次性列 50 条会淹没真正的错误，读者很快就会学会无视这段输出 ——
 * 那等于这条检查不存在。要看明细加 `--list`。
 */
if (warnings.length) {
  console.log(`  提示：${warnings.length} 个 key 未被静态引用（可能是动态拼接或历史遗留）`);
  if (process.argv.includes("--list")) {
    for (const w of warnings) console.log(`    · ${w}`);
  } else {
    console.log("        明细：node scripts/check-i18n.mjs --list");
  }
}
