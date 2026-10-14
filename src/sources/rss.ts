/** 通用 RSS / Atom 解析（fast-xml-parser，WebView 内零 Node 依赖） */
import { XMLParser } from "fast-xml-parser";
import { httpText } from "./http";
import type { SourceEntry } from "./types";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

/** fast-xml-parser 会把单元素包成 {#text}，统一取文本 */
function text(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("#text" in o) return text(o["#text"]);
    if ("@_href" in o) return text(o["@_href"]);
  }
  return "";
}

function parseDate(v: unknown): number | undefined {
  const s = text(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchRssEntries(url: string, limit = 50): Promise<SourceEntry[]> {
  const xml = await httpText(url);
  const doc = parser.parse(xml) as Record<string, any>;

  // RSS 2.0
  const items = doc?.rss?.channel?.item;
  if (Array.isArray(items) || items) {
    return (Array.isArray(items) ? items : [items]).slice(0, limit).map((it: any) => {
      const desc = stripHtml(text(it.description));
      return {
        id: text(it.guid) || text(it.link),
        title: text(it.title),
        url: text(it.link),
        pubDate: parseDate(it.pubDate),
        extra: desc ? { hover: desc } : undefined,
      };
    });
  }

  // Atom
  const entries = doc?.feed?.entry;
  if (Array.isArray(entries) || entries) {
    return (Array.isArray(entries) ? entries : [entries]).slice(0, limit).map((it: any) => {
      const links = Array.isArray(it.link) ? it.link : [it.link].filter(Boolean);
      const alt = links.find((l: any) => l?.["@_rel"] === "alternate") ?? links[0];
      const desc = stripHtml(text(it.content) || text(it.summary));
      return {
        id: text(it.id) || text(alt),
        title: text(it.title),
        url: text(alt),
        pubDate: parseDate(it.updated),
        extra: desc ? { hover: desc } : undefined,
      };
    });
  }

  throw new Error(`Unrecognized feed format: ${url}`);
}
