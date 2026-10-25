import { useEffect, useMemo, useRef, useState } from "react";
import { Hash, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/ahub/lib/utils";
import { groupTags } from "@/ahub/lib/tag-groups";
import { useTagGroups } from "@/ahub/stores/tag-groups";

/**
 * 检索面板（B）：⌘K 唤起，输入即筛，↑↓ 选、回车切换标签、Esc 关。
 *
 * 标签墙不常驻，日常仍用卡片仓；这个面板只服务"手已经在键盘上"的那一类检索。
 */
export function TagCommand({
  open,
  onOpenChange,
  allTags,
  counts,
  selected,
  onToggle,
  resultCount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allTags: string[];
  counts?: Record<string, number>;
  selected: Set<string>;
  onToggle: (tag: string) => void;
  resultCount: number;
}) {
  const { t } = useTranslation();
  const groups = useTagGroups((s) => s.groups);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const view = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = q ? allTags.filter((tag) => tag.toLowerCase().includes(q)) : allTags;
    return groupTags(visible, groups);
  }, [allTags, groups, query]);

  const flat = useMemo(() => [...view.groups.flatMap((g) => g.tags), ...view.ungrouped], [view]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const focus = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(focus);
  }, [open]);

  useEffect(() => setActive(0), [query]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]" onClick={() => onOpenChange(false)}>
      <div
        className="w-[560px] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Search className="size-4 text-ink-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onOpenChange(false);
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((index) => Math.min(index + 1, flat.length - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) => Math.max(index - 1, 0));
              }
              if (event.key === "Enter" && flat[active]) onToggle(flat[active]);
            }}
            placeholder={t("tagCommand.placeholder")}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-3"
          />
          <kbd className="rounded border border-border px-1 font-mono text-[9.5px] text-ink-3">esc</kbd>
        </div>

        <div className="max-h-[46vh] overflow-y-auto p-1.5">
          {view.groups.map((group) => (
            <section key={group.id} className="mb-1">
              <p className="px-2 py-1 text-[10.5px] font-medium text-ink-3">{group.name}</p>
              {group.tags.map((tag) => (
                <Row key={tag} tag={tag} count={counts?.[tag]} on={selected.has(tag)} active={flat[active] === tag} onToggle={onToggle} />
              ))}
            </section>
          ))}
          {view.ungrouped.length > 0 ? (
            <section>
              <p className="px-2 py-1 text-[10.5px] font-medium text-ink-3">{t("tagShelf.ungrouped")}</p>
              {view.ungrouped.map((tag) => (
                <Row key={tag} tag={tag} count={counts?.[tag]} on={selected.has(tag)} active={flat[active] === tag} onToggle={onToggle} />
              ))}
            </section>
          ) : null}
          {flat.length === 0 ? <p className="px-3 py-6 text-center text-[11.5px] text-ink-3">{t("tagManager.empty")}</p> : null}
        </div>

        <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[10.5px] text-ink-3">
          <span className="flex items-center gap-1">
            <Hash className="size-3" />
            {t("tagCommand.hits", { n: resultCount })}
          </span>
          <span className="ml-auto">{t("tagCommand.hint")}</span>
        </div>
      </div>
    </div>
  );
}

function Row({ tag, count, on, active, onToggle }: { tag: string; count?: number; on: boolean; active: boolean; onToggle: (tag: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onToggle(tag)}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px]",
        active ? "bg-primary-soft text-foreground" : "text-ink-2 hover:bg-muted/60",
      )}
    >
      <span className={cn("size-1.5 rounded-[1px]", on ? "bg-primary" : "bg-ink-3/60")} />
      <span className="min-w-0 flex-1 truncate">{tag}</span>
      {count ? <span className="font-mono text-[10px] text-ink-3">{count}</span> : null}
      {on ? <span className="text-[10px] text-primary">✓</span> : null}
    </button>
  );
}
