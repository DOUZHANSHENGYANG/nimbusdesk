/**
 * 工具箱的纯逻辑：列表筛选、标签增删、体积与时间格式化。
 *
 * 单独放一个文件是为了能被 `node:test` 直接跑（本目录的 core.test.mjs）：
 * 这些函数都是「看起来显然、边界上会错」的那一类 —— 比如筛选条件里有多个
 * 空格分隔的词、标签去重、以及 1023/1024 的进位点。
 */

export interface Searchable {
  name: string;
  description: string;
  tags: string[];
}

/**
 * 多词筛选的原子：查询按空白切开，**每个**词都要命中给定字段里的任意一处。
 * 技能用 `filterItems`（字段是 name/description/tags），提示词用这个函数
 * （字段是 title/description/tags）—— 只有一份匹配实现，两处不会漂移。
 */
export function matchQuery(query: string, parts: (string | string[])[]): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = parts.flat().join("\n").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** 技能/条目列表的筛选。 */
export function filterItems<T extends Searchable>(items: T[], query: string): T[] {
  return items.filter((item) => matchQuery(query, [item.name, item.description, item.tags]));
}

/** 加标签：去空白、去重、忽略空串（中英文逗号都当分隔符，用户习惯黏在一起写）。 */
export function addTags(list: string[], raw: string): string[] {
  const next = [...list];
  for (const part of raw.split(/[,，\n]/)) {
    const tag = part.trim();
    if (tag && !next.includes(tag)) next.push(tag);
  }
  return next;
}

export function removeTag(list: string[], tag: string): string[] {
  return list.filter((item) => item !== tag);
}

/** 人类可读体积（1024 进制，一位小数）。 */
export function sizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** 时间戳 → 本地日期时间。解析不了时返回空串（不显示 Invalid Date）。 */
export function timeLabel(iso: string, lang: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(lang === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 名字里带分隔符的服务在别家工具配置里是非法键名，导出前先挡掉。 */
export function mcpNameProblem(name: string): "empty" | "separator" | null {
  if (!name.trim()) return "empty";
  if (/[\\/]/.test(name)) return "separator";
  return null;
}

/**
 * 环境变量 / 请求头这类「键值对」用一行一条 `KEY=value` 的文本编辑。
 *
 * 用文本而不是逐行输入框：MCP 的环境变量通常是从文档整段粘过来的，
 * 粘贴一次比敲十几个输入框快得多。只按**第一个** `=` 切分，
 * 所以 value 里再出现 `=` 或 URL 查询串不会被打断。
 */
export function parsePairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at <= 0) continue;
    const key = trimmed.slice(0, at).trim();
    if (key) out[key] = trimmed.slice(at + 1).trim();
  }
  return out;
}

/** 键值对 → 一行一条文本（键排序，便于人眼比对）。 */
export function formatPairs(map: Record<string, string>): string {
  return Object.keys(map)
    .sort()
    .map((key) => `${key}=${map[key]}`)
    .join("\n");
}

/* ── 标签筛选 ─────────────────────────────────────────── */

export type TagMode = "or" | "and";

/** 一组标签是否满足所选标签的与/或条件。 */
export function matchTags(itemTags: string[], selected: Set<string>, mode: TagMode): boolean {
  if (selected.size === 0) return true;
  const has = (tag: string) => itemTags.includes(tag);
  if (mode === "and") return [...selected].every(has);
  return [...selected].some(has);
}

/** 出现过的标签，按使用次数降序（同次数按名字，保证顺序稳定）。 */
export function collectTags(items: { tags: string[] }[]): { tags: string[]; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const item of items) for (const tag of item.tags) counts[tag] = (counts[tag] ?? 0) + 1;
  const tags = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  return { tags, counts };
}

/* ── 版本差异（行级 LCS）─────────────────────────────── */

export type DiffRow = { type: "same" | "add" | "del"; text: string };

const MAX_DIFF_LINES = 2000;

/**
 * 行级 diff（LCS 动态规划）。技能正文通常几百行，O(n·m) 完全够用；
 * 超长内容退化为「整块删除 + 整块新增」以免卡住界面。
 */
export function diffLines(a: string, b: string): DiffRow[] {
  // 空字符串代表「没有内容」，按 0 行处理，避免凭空多出一行差异
  const la = a === "" ? [] : a.split("\n");
  const lb = b === "" ? [] : b.split("\n");
  if (la.length > MAX_DIFF_LINES || lb.length > MAX_DIFF_LINES) {
    return [
      ...la.map((text) => ({ type: "del" as const, text })),
      ...lb.map((text) => ({ type: "add" as const, text })),
    ];
  }
  // LCS 表：回溯需要全表，所以用 Int32Array 扁平存储
  const n = la.length;
  const m = lb.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        la[i] === lb[j] ? dp[(i + 1) * w + (j + 1)] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (la[i] === lb[j]) {
      out.push({ type: "same", text: la[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      out.push({ type: "del", text: la[i] });
      i++;
    } else {
      out.push({ type: "add", text: lb[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: la[i++] });
  while (j < m) out.push({ type: "add", text: lb[j++] });
  return out;
}

export function diffStat(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.type === "add") added++;
    else if (row.type === "del") removed++;
  }
  return { added, removed };
}

/**
 * 只保留变更附近的行，其余折成一行省略号。
 *
 * 纯增删（没有一行相同）时**不折叠**：那样会把整段差异折成「⋯」，
 * 用户点开却什么也看不到。
 */
export function collapseContext(rows: DiffRow[], padding = 2): (DiffRow | { type: "gap"; text: string })[] {
  const keep = new Set<number>();
  rows.forEach((row, i) => {
    if (row.type === "same") return;
    for (let k = i - padding; k <= i + padding; k++) if (k >= 0 && k < rows.length) keep.add(k);
  });
  const out: (DiffRow | { type: "gap"; text: string })[] = [];
  let skipping = false;
  rows.forEach((row, i) => {
    if (keep.has(i)) {
      out.push(row);
      skipping = false;
    } else if (!skipping) {
      out.push({ type: "gap", text: "…" });
      skipping = true;
    }
  });
  return out;
}

/**
 * 去掉 frontmatter，只留正文。
 *
 * 技能的版本快照存的是整份 SKILL.md（含 frontmatter），而 UI 传进来比对的
 * 往往是正文 —— 不剥掉会永远判成「有改动」。
 */
export function bodyOf(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n?/, "");
}

