import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RiArrowDownSLine, RiArrowUpSLine, RiCloseLine, RiHashtag, RiSearchLine } from "@remixicon/react";
import { useKnowledgeCopy } from "./copy";
import { readTags } from "./metadata";
import type { KnowledgeNote } from "./types";

export const UNTAGGED = "\u0000untagged";
const COLLAPSED_HEIGHT = 58; // Two 26px chip rows with a 6px gap.

export function noteTags(note: KnowledgeNote): string[] {
  try { return readTags(note.frontmatter ?? ""); } catch { return []; }
}

export function TagBrowser({ notes, selected, onSelect }: { notes: KnowledgeNote[]; selected: string | null; onSelect: (tag: string | null) => void }) {
  const c = useKnowledgeCopy();
  const en = c.allTags === "All tags";
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [canExpand, setCanExpand] = useState(false);
  const [visibleCount, setVisibleCount] = useState(Infinity);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const counts = useMemo(() => {
    const tags = new Map<string, number>(); let untagged = 0;
    for (const note of notes) {
      const values = noteTags(note);
      if (!values.length) untagged++;
      for (const tag of values) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }
    return { untagged, tags: [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) };
  }, [notes]);
  const matches = useMemo(() => counts.tags.filter(([tag]) => tag.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [counts, query]);

  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => {
      const children = Array.from(element.children) as HTMLElement[];
      const top = children[0]?.offsetTop ?? 0;
      setVisibleCount(children.filter((child) => child.offsetTop - top < COLLAPSED_HEIGHT).length);
      setCanExpand(element.scrollHeight > COLLAPSED_HEIGHT + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [matches]);

  function chip(tag: string | null, label: string, count: number, index: number) {
    const hidden = !expanded && index >= visibleCount;
    return <button key={tag ?? "all"} type="button" title={label} aria-pressed={selected === tag} aria-hidden={hidden || undefined} tabIndex={hidden ? -1 : 0}
      onClick={() => onSelect(tag)} className="knowledge-tag-chip" data-active={selected === tag}>
      <span className="knowledge-tag-chip-label">{label}</span><span className="knowledge-tag-chip-count">{count}</span>
    </button>;
  }
  const activeLabel = selected === UNTAGGED ? c.untagged : selected;
  return <section aria-label={c.tagBrowse} className="knowledge-tag-browser">
    <div className="knowledge-tag-header">
      <div className="knowledge-tag-heading">
        <span className="knowledge-tag-title"><RiHashtag aria-hidden="true" />{c.tagBrowse}</span>
        {activeLabel && <button type="button" onClick={() => onSelect(null)} aria-label={`${en ? "Clear tag filter" : "清除标签筛选"}: ${activeLabel}`} title={activeLabel}
          className="knowledge-tag-active-filter"><span>{activeLabel}</span><RiCloseLine aria-hidden="true" /></button>}
      </div>
      {canExpand && <button type="button" aria-controls={listId} aria-expanded={expanded} onClick={() => { setExpanded(!expanded); if (list.current) list.current.scrollTop = 0; }} className="knowledge-tag-toggle">
        {expanded ? <RiArrowUpSLine aria-hidden="true" /> : <RiArrowDownSLine aria-hidden="true" />}{expanded ? (en ? "Collapse tags" : "收起标签") : (en ? `Show all ${matches.length} tags` : `展开全部 ${matches.length} 个标签`)}
      </button>}
      <div className="knowledge-search-field knowledge-tag-search">
        <RiSearchLine aria-hidden="true" /><input ref={search} aria-label={c.findTag} placeholder={c.findTag} value={query} onChange={(event) => { setQuery(event.target.value); setExpanded(false); if (list.current) list.current.scrollTop = 0; }} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); } }} /><span className="knowledge-search-suffix">{query && <button type="button" aria-label={c.clearTagSearch} title={c.clearTagSearch} onClick={() => { setQuery(""); search.current?.focus(); }}><RiCloseLine /></button>}</span>
      </div>
    </div>
    <div id={listId} ref={list} className="knowledge-tag-list" style={{ maxHeight: expanded ? 224 : COLLAPSED_HEIGHT, overflowY: expanded ? "auto" : "hidden" }}>
      {chip(null, c.allTags, notes.length, 0)}{chip(UNTAGGED, c.untagged, counts.untagged, 1)}
      {matches.map(([tag, count], index) => chip(tag, tag, count, index + 2))}
    </div>
    {query.trim() && matches.length === 0 && <p role="status" className="knowledge-tag-empty">{c.noMatching}</p>}
  </section>;
}
