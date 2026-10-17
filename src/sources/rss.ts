/** RSS/Atom parsing shared by subscription probing and source adapters. */
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { httpText } from "./http";
import type { SourceEntry } from "./types";
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
export interface FeedPreview {
    title: string;
    url: string;
    entries: SourceEntry[];
}
function text(value: unknown): string {
    if (typeof value === "string" || typeof value === "number")
        return String(value).trim();
    if (value && typeof value === "object") {
        const item = value as Record<string, unknown>;
        return text(item["#text"] ?? item["@_href"]);
    }
    return "";
}
const array = (value: any): any[] => value == null ? [] : Array.isArray(value) ? value : [value];
function date(value: unknown) { const result = Date.parse(text(value)); return Number.isFinite(result) ? result : undefined; }
function stripHtml(value: unknown) {
    return text(value).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}
export function normalizeFeedUrl(input: string): string {
    const url = new URL(input.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.includes('...') || url.href.includes('%E2%80%A6'))
        throw new Error('Invalid feed URL');
    url.hash = '';
    return url.href;
}
export function parseRssFeed(xml: string, url: string, limit = 50): FeedPreview {
    if (XMLValidator.validate(xml) !== true)
        throw new Error('Invalid RSS / Atom XML');
    const doc = parser.parse(xml);
    const channel = doc?.rss?.channel;
    const feed = doc?.feed;
    if (!channel && !feed)
        throw new Error('Not an RSS / Atom feed');
    const seen = new Set<string>();
    const entries: SourceEntry[] = [];
    for (const item of array(channel ? channel.item : feed.entry)) {
        const links = array(item.link);
        const link = channel ? links[0] : links.find(value => value?.['@_rel'] === 'alternate' && (!value?.['@_type'] || value['@_type'] === 'text/html')) ?? links.find(value => !value?.['@_rel']);
        let articleUrl: string;
        try {
            if (!text(link))
                continue;
            articleUrl = normalizeFeedUrl(new URL(text(link), url).href);
        }
        catch {
            continue;
        }
        const title = stripHtml(item.title);
        if (!title || seen.has(articleUrl))
            continue;
        seen.add(articleUrl);
        const hover = stripHtml(item.description ?? item.summary ?? item.content);
        const full = item['content:encoded'] ?? item.content ?? item.description ?? item.summary;
        const value = text(full);
        const format = full?.['@_type'] === 'text' ? 'text' : /<\/?[a-z][^>]*>/i.test(value) ? 'html' : 'text';
        entries.push({ id: text(item.guid ?? item.id) || articleUrl, title, url: articleUrl, pubDate: date(item.pubDate ?? item.published ?? item.updated), extra: hover ? { hover } : undefined, content: value ? {format, value} : undefined });
        if (entries.length >= limit)
            break;
    }
    return { title: text(channel?.title ?? feed?.title) || new URL(url).hostname, url, entries };
}
export async function probeFeed(input: string, signal?: AbortSignal): Promise<FeedPreview> {
    const url = normalizeFeedUrl(input);
    const content = await httpText(url, { signal }, 30000);
    try {
        return parseRssFeed(content, url);
    }
    catch (error) {
        if (!/<html[\s>]|<!doctype html/i.test(content))
            throw error;
        // Follow one explicitly advertised feed, never crawl a site.
        const document = new DOMParser().parseFromString(content, 'text/html');
        const href = document.querySelector('link[rel~="alternate"][type="application/rss+xml"],link[rel~="alternate"][type="application/atom+xml"]')?.getAttribute('href');
        if (!href)
            throw error;
        const discovered = normalizeFeedUrl(new URL(href, url).href);
        return parseRssFeed(await httpText(discovered, { signal }, 30000), discovered);
    }
}
export async function fetchRssEntries(url: string, limit = 50, signal?: AbortSignal): Promise<SourceEntry[]> {
    return parseRssFeed(await httpText(url, { signal }, 30000), url, limit).entries;
}
