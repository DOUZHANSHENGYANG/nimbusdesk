import { createElement, useId, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SourceEntry } from "@/sources/types";
import "./article-reader.css";

const ALLOWED = new Set("p div span h1 h2 h3 h4 h5 h6 strong b em i u s del ul ol li blockquote pre code hr br table thead tbody tfoot tr th td figure figcaption sup sub dl dt dd".split(" "));
const REMOVED = "script,style,noscript,iframe,object,embed,svg,math,form,input,button,select,textarea,video,audio,link,meta,base,template";

function externalUrl(input: string, base: string): string | null {
  if (!input.trim()) return null;
  try {
    const url = new URL(input, base);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Render only semantic elements and selected attributes; source HTML is never inserted. */
export function ArticleReader({ entry, sourceName, onOpen }: {
  entry: SourceEntry;
  sourceName: string;
  onOpen: (url: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const prefix = useId();
  const content = entry.content;
  const parsed = useMemo(() => {
    if (content?.format !== "html") return null;
    const body = new DOMParser().parseFromString(content.value, "text/html").body;
    body.querySelectorAll(REMOVED).forEach(node => node.remove());
    const titleElement = body.querySelector("h1");
    const title = titleElement?.textContent?.trim();
    const useContentTitle = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(entry.title) && !!title;
    const heading = useContentTitle ? title! : entry.title;
    const omitTitle = title === heading ? titleElement : null;
    const sections = Array.from(body.querySelectorAll("h2")).filter(node => node.textContent?.trim());
    const anchors = new Map(Array.from(body.querySelectorAll("[id]")).map((node, index) => [node, `${prefix}-anchor-${index}`]));
    sections.forEach((node, index) => { if (!anchors.has(node)) anchors.set(node, `${prefix}-section-${index}`); });
    return { body, heading, omitTitle, sections, anchors };
  }, [content, entry.title, prefix]);

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }

  function render(node: Node, key: string): ReactNode {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE || node === parsed?.omitTitle) return null;
    const element = node as Element;
    const tag = element.localName.toLowerCase();
    const children = Array.from(element.childNodes).map((child, index) => render(child, `${key}-${index}`));
    const id = parsed?.anchors.get(element);
    if (tag === "a") {
      const href = element.getAttribute("href") || "";
      if (href.startsWith("#")) {
        let fragment = href.slice(1);
        try { fragment = decodeURIComponent(fragment); } catch { /* Keep malformed fragments inert. */ }
        const target = Array.from(parsed?.anchors ?? []).find(([item]) => item.id === fragment)?.[1];
        return target ? <a key={key} href={`#${target}`} onClick={event => { event.preventDefault(); scrollTo(target); }}>{children}</a> : <span key={key}>{children}</span>;
      }
      const url = externalUrl(href, entry.url);
      return url ? <a key={key} href={url} rel="noopener noreferrer" onClick={event => { event.preventDefault(); onOpen(url); }}>{children}</a> : <span key={key}>{children}</span>;
    }
    // Remote images remain explicit links instead of loading tracking resources.
    if (tag === "img") {
      const url = externalUrl(element.getAttribute("src") || "", entry.url);
      const alt = element.getAttribute("alt")?.trim();
      return url && alt ? <a key={key} className="feed-article-image" href={url} onClick={event => { event.preventDefault(); onOpen(url); }}>{alt} ↗</a> : null;
    }
    if (!ALLOWED.has(tag)) return <span key={key}>{children}</span>;
    if (tag === "br" || tag === "hr") return createElement(tag, { key });
    if (!children.some(child => child !== null && (typeof child !== "string" || child.trim()))) return null;
    const props: Record<string, unknown> = { key, id };
    if (tag === "ol" && /^\d{1,4}$/.test(element.getAttribute("start") || "")) props.start = Number(element.getAttribute("start"));
    const result = createElement(tag, props, children);
    return tag === "table" ? <div key={key} className="feed-article-table">{result}</div> : result;
  }

  const plain = content?.value || entry.extra?.hover || "";
  return (
    <article className="feed-article select-text">
      <header className="feed-article-header">
        <p className="feed-article-source">{sourceName}</p>
        <h1>{parsed?.heading || entry.title}</h1>
        {entry.pubDate && Number.isFinite(entry.pubDate) ? <time dateTime={new Date(entry.pubDate).toISOString()}>{new Date(entry.pubDate).toLocaleString(i18n.language === "en" ? "en-US" : "zh-CN", {year:"numeric",month:"long",day:"numeric",hour:"2-digit",minute:"2-digit"})}</time> : null}
        {entry.extra?.info && <span className="feed-article-info">{entry.extra.info}</span>}
      </header>
      {parsed && parsed.sections.length > 2 && (
        <nav className="feed-article-contents" aria-label={t("feeds.articleContents")}>
          {parsed.sections.map(node => <button type="button" key={parsed.anchors.get(node)} onClick={() => scrollTo(parsed.anchors.get(node)!)}>{node.textContent}</button>)}
        </nav>
      )}
      <div className="feed-article-body">
        {parsed ? Array.from(parsed.body.childNodes).map((node, index) => render(node, String(index))) : plain.split(/\n\s*\n/).filter(Boolean).map((paragraph, index) => <p key={index} className="whitespace-pre-line">{paragraph}</p>)}
      </div>
    </article>
  );
}
