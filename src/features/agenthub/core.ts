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
