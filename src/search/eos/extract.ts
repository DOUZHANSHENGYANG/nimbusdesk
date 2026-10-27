/**
 * 从搜索页 HTML 里抽结果条目。
 *
 * 不引入 HTML 解析器：这批站点的搜索页结构各不相同，没有一套选择器能通用，
 * 按 `DETAIL_HINT` 给链接打分反而更稳（实测 215 条规则里 37 条能抽出 ≥2 条）。
 * 纯字符串扫描，也不依赖 DOM —— 单元测试能在 node 里直接跑。
 */
import type { EosRule } from "./rule";

export interface EosHit {
  title: string;
  url: string;
  /** 命中的规则，用于分组徽标与"来自哪个站" */
  ruleTitle: string;
  group: string;
  score: number;
}

/** 导航/页脚类锚文本，不是结果 */
const NAV_TEXT = /^(首页|上一页|下一页|上一章|下一章|登录|注册|更多|关于|帮助|隐私|协议|反馈|返回|下载|客户端|APP|广告|搜索|全部|热门|推荐|English|中文|登录\/注册)$/i;
/** 站内搜索框、外站搜索跳板：看起来像结果，点开还是搜索页 */
const WIDGET_TEXT = /(搜本站|站内搜索|搜索此站|Google\s*(中)?搜|百度搜索|必应搜索)/i;
/** 备案/法务/第三方跳板，一律丢弃 */
const NAV_HOST = /(beian\.gov\.cn|beian\.mps\.gov\.cn|12377\.cn|miit\.gov\.cn|creativecommons\.org|go\.microsoft\.com|privacy\.qq\.com|shared\.ydstatic\.com|support\.qq\.com)/i;
/** 详情页特征：命中则更像一条结果 */
const DETAIL_HINT = /(\/question\/|\/p\/|\/post\/|\/article\/|\/a\/|\/s\/|\/video\/|\/detail|\/thread-|\/t\/|\/repo|\/repository|\/course\/|\/book\/|\/subject\/|\/item\/|\/mods?\/|\/movie\/|\/archives?\/|\/html\/|\/vod\/|\d{4,})/i;
/** 资源直链：网盘 / 磁力 / ed2k */
const RESOURCE = [
  /magnet:\?xt=urn:btih:[a-zA-Z0-9]{10,}/g,
  /ed2k:\/\/\|file\|[^"'\s<>]{0,200}/g,
  /https?:\/\/(?:pan\.baidu\.com|www\.alipan\.com|www\.aliyundrive\.com|pan\.quark\.cn|pan\.xunlei\.com|cloud\.189\.cn)\/[^"'\s<>\\]{0,120}/g,
];

const ENTITY: Record<string, string> = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#215;": "×" };

function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39|#215);/g, (m) => ENTITY[m] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/**
 * 关键词是否真的出现在文本里。
 *
 * ASCII 关键词必须按词边界匹配：搜 `react` 时，`Reactor`、`Reactive` 都不算命中
 * —— 实测 7723 一个站就能用 `Reactor` 刷满整屏。中文没有词边界，退回子串匹配。
 */
export function matchesKeyword(text: string, keyword: string): boolean {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return false;
  const hay = text.toLowerCase();
  if (!/^[\x20-\x7f]+$/.test(kw)) return hay.includes(kw);
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(hay);
}

/**
 * 抽一条结果要满足：有像样的锚文本、不是导航、指向详情页或含关键词。
 * 打分而不是硬过滤 —— 硬过滤在不同站点上会漏掉一半。
 */
export function extractHits(html: string, pageUrl: string, keyword: string, rule: EosRule): EosHit[] {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const pageHost = hostOf(pageUrl);
  const seen = new Set<string>();
  const hits: EosHit[] = [];

  const anchor = /<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(cleaned))) {
    const text = plainText(match[2]);
    if (text.length < 4 || text.length > 160) continue;
    if (NAV_TEXT.test(text) || WIDGET_TEXT.test(text)) continue;

    const href = match[1].trim();
    if (!href || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) continue;
    // 直接给安装包的链接不是"搜索结果"，用户点开就是下载一个文件
    if (/\.(apk|exe|dmg|zip|rar|7z|torrent)(\?|#|$)/i.test(href)) continue;

    let url: string;
    try { url = new URL(href, pageUrl).href; } catch { continue; }
    if (!/^https?:/i.test(url) || url === pageUrl || NAV_HOST.test(url)) continue;

    // 同一路径只留一次（不同 query 常是同一篇文章的追踪参数）
    const key = url.replace(/[#?].*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);

    let score = 0;
    if (matchesKeyword(text, keyword)) score += 3;
    if (DETAIL_HINT.test(url)) score += 2;
    if (hostOf(url) !== pageHost) score += 1;
    if (text.length >= 12) score += 1;
    // 关键词只出现在 URL 编码里、锚文本完全不含它 → 多半是站点推荐的无关内容
    if (!matchesKeyword(text, keyword)) {
      let decoded = url;
      try { decoded = decodeURIComponent(url); } catch { /* 保留原样 */ }
      if (!matchesKeyword(decoded, keyword)) score -= 3;
    }
    if (score < 3) continue;

    hits.push({ title: text, url, ruleTitle: rule.title, group: rule.group, score });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/**
 * 页面里直接出现的网盘/磁力/ed2k 链接。
 *
 * 带上锚点文本：站点的结果标题（如「510_深入浅出搞定 React」）往往不在 URL 里，
 * 只拿 URL 当标题的话，用户看到一串乱码般的外链。
 */
export interface EosResource {
  url: string;
  label: string;
}

export function extractResources(html: string, keyword?: string): EosResource[] {
  const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const out: EosResource[] = [];
  const seen = new Set<string>();
  for (const pattern of RESOURCE) {
    for (const url of cleaned.match(pattern) ?? []) {
      if (seen.has(url)) continue;
      const label = anchorLabel(cleaned, url);
      if (keyword && !matchesKeyword(label, keyword) && !resourceContextMatches(cleaned, url, keyword)) continue;
      seen.add(url);
      out.push({ url, label });
    }
  }
  return out;
}

/**
 * 资源链接是否属于这次搜索。
 *
 * 只看**它自己所在的那个锚点**的文本 —— 用固定字数的上下文窗口会跨进相邻结果块，
 * 把同一页里别的热门资源也算进来（实测就是这样漏过的）。
 * 链接不在锚点里时（少数站直接写在正文），退回紧邻的 60 字符。
 */
function resourceContextMatches(html: string, url: string, keyword: string): boolean {
  const at = html.indexOf(url);
  if (at < 0) return false;

  const open = html.lastIndexOf("<a", at);
  const close = html.indexOf("</a>", at);
  if (open >= 0 && close > open && close - open < 1200) {
    return matchesKeyword(plainText(html.slice(open, close)), keyword);
  }
  return matchesKeyword(plainText(html.slice(Math.max(0, at - 60), at + url.length + 60)), keyword);
}

/** 锚点里的可读文本：优先 h1–h4 标题，否则整段文本 */
function anchorLabel(html: string, url: string): string {
  const at = html.indexOf(url);
  if (at < 0) return "";
  const open = html.lastIndexOf("<a", at);
  const close = html.indexOf("</a>", at);
  if (open < 0 || close <= open) return "";
  const inner = html.slice(open, close);
  const heading = /<h[1-4][^>]*>([\s\S]{0,200}?)<\/h[1-4]>/i.exec(inner);
  return plainText(heading ? heading[1] : inner).slice(0, 120);
}
