import { isMap, isNode, parseDocument } from "yaml";

export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().replace(/^#+/, "").replace(/\s+/g, "-")).filter(Boolean))].slice(0, 30);
}
export function frontmatterRange(content: string) {
  const bom = content.startsWith("\ufeff") ? 1 : 0;
  const opening = /^---[ \t]*\r?\n/.exec(content.slice(bom));
  if (!opening) return null;
  const start = bom + opening[0].length;
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(content.slice(start));
  if (!closing) throw new Error("笔记属性区未闭合，请先修复 frontmatter。");
  return { start, end: start + closing.index, body: start + closing.index + closing[0].length, yaml: content.slice(start, start + closing.index) };
}
function document(yaml: string) {
  const doc = parseDocument(yaml, { uniqueKeys: true, strict: true });
  if (doc.errors.length) throw new Error("笔记属性区格式有误，未修改原文。");
  if (doc.contents && !isMap(doc.contents)) throw new Error("笔记属性区必须为键值表。");
  return doc;
}
export function readTags(yaml: string): string[] {
  if (!yaml.trim()) return [];
  const value = document(yaml).toJS({ maxAliasCount: 0 })?.tags;
  if (value == null) return [];
  if (typeof value === "string") return normalizeTags(value.split(/[,，]/));
  if (Array.isArray(value) && value.every((tag) => typeof tag === "string")) return normalizeTags(value);
  throw new Error("tags 属性需要是文本或文本列表，未修改原文。");
}
export function tagsFromContent(content: string): string[] {
  const range = frontmatterRange(content);
  return range ? readTags(range.yaml) : [];
}
/** Edit only the YAML tags value, preserving all other source bytes. */
export function withTags(content: string, tags: string[], onlyMissing = false): string {
  const normalized = normalizeTags(tags);
  const range = frontmatterRange(content);
  if (onlyMissing && tagsFromContent(content).length) return content;
  const value = JSON.stringify(normalized);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  if (!range) {
    const bom = content.startsWith("\ufeff") ? "\ufeff" : "";
    return `${bom}---${newline}tags: ${value}${newline}---${newline}${newline}${content.slice(bom.length)}`;
  }
  const doc = document(range.yaml);
  const node = doc.get("tags", true);
  if (isNode(node) && node.range) {
    const [start, end] = node.range;
    const padding = start === end && range.yaml[start - 1] === ":" ? " " : "";
    const trailing = /\r?\n$/.test(range.yaml.slice(start, end)) ? newline : "";
    return content.slice(0, range.start + start) + padding + value + trailing + content.slice(range.start + end);
  }
  const prefix = range.yaml && !range.yaml.endsWith("\n") ? newline : "";
  return content.slice(0, range.end) + `${prefix}tags: ${value}${newline}` + content.slice(range.end);
}

const TOPICS: [string, RegExp][] = [
  ["Oracle", /oracle|sqlplus|pl[ /_-]?sql/i], ["SQL", /\bsql\b|数据库|多表连接|表空间/i],
  ["Java", /\bjava\b|spring\s?boot|mybatis/i], ["SpringBoot", /spring\s?boot/i], ["MyBatis-Plus", /mybatis/i],
  ["Vue", /\bvue\b|vue3|nuxt/i], ["React", /\breact\b|next\.js|nextjs/i], ["TypeScript", /typescript|\btsx?\b/i],
  ["JavaScript", /javascript|\bjs\b/i], ["NPM", /\bnpm\b|pnpm|包管理/i], ["NVM", /\bnvm\b/i],
  ["Node.js", /node\.js|nodejs|node package manager/i], ["Git", /\bgit\b|gitbutler|worktree/i], ["Docker", /docker|容器化/i],
  ["Tauri", /tauri|webview2/i], ["Electron", /electron/i], ["Obsidian", /obsidian|wikilink/i],
  ["MCP", /\bmcp\b/i], ["OpenAI", /openai|chatgpt|codex/i], ["Agent", /\bagent\b|智能体|代理编排/i],
  ["Skills", /skills?-manager|技能管理|\bskill\b/i], ["AI", /\bai\b|大模型|llm|模型配置/i],
  ["WPS", /\bwps\b|excel|办公自动化/i], ["SearXNG", /searxng/i], ["V2Ray", /v2ray|vless|vmess/i],
  ["JetBrains", /jetbrains|intellij|datagrip/i], ["音频", /音频|音乐|节拍|播放/i],
];
export function inferTags(path: string, content: string): string[] {
  const title = path.replace(/\\/g, "/").split("/").pop() || "";
  const candidates = TOPICS.map(([tag, pattern], index) => ({ tag, index, score: (pattern.test(title) ? 8 : 0) + (pattern.test(path) ? 4 : 0) + (pattern.test(content.slice(0, 20000)) ? 1 : 0) }))
    .filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const strong = candidates.filter((item) => item.score >= 4);
  const scored = (strong.length ? strong : candidates.slice(0, 2)).slice(0, 4).map((item) => item.tag);
  const normalizedPath = path.replace(/\\/g, "/");
  const context = `${title}\n${content.match(/^#\s+.+/m)?.[0] || ""}`;
  if (/排错|排查|故障|报错|修复|debug/i.test(context)) scored.push("排错");
  else if (/部署|安装|搭建/i.test(context)) scored.push("部署");
  else if (/配置|设置/i.test(context)) scored.push("配置");
  if (/项目经验|开发经验/.test(path)) scored.push("开发经验");
  else if (/资源收藏/.test(path)) scored.push("资源收藏");
  if (!scored.length) {
    const folder = normalizedPath.split("/").slice(-2, -1)[0]?.replace(/^\d+[-_]/, "");
    if (folder && !["收件箱", "工作台", "工作", "技术"].includes(folder)) scored.push(folder);
  }
  return normalizeTags(scored).slice(0, 6);
}
