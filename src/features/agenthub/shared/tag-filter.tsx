import { Tag } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { TagMode } from "../core";

export type { TagMode };

/**
 * 标签筛选条：多选叠加，选中的标签在「与」模式下需全部命中，「或」模式命中任意一个。
 * 选中 ≥2 个时才出现与/或切换 —— 一个标签时这两种逻辑是同一件事。
 */
export function TagFilter({
  allTags,
  selected,
  onChange,
  mode,
  onModeChange,
  searchable,
  className,
  counts,
  hideWhenEmpty = true,
}: {
  allTags: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  mode: TagMode;
  onModeChange: (m: TagMode) => void;
  /** 标签很多时显示标签搜索框 */
  searchable?: boolean;
  /** 外层容器 class（默认 mb-4，嵌进其他面板时传 "" 去掉） */
  className?: string;
  /** 标签 → 数量，显示在胶囊右侧的弱化色里 */
  counts?: Record<string, number>;
  /** 无标签时是否隐藏整条；页面级筛选栏应传 false */
  hideWhenEmpty?: boolean;
}) {
  const { t } = useTranslation();
  const [tagQuery, setTagQuery] = useState("");

  const visibleTags = useMemo(() => {
    const q = tagQuery.trim().toLowerCase();
    if (!q) return allTags;
    return allTags.filter((tag) => tag.toLowerCase().includes(q));
  }, [allTags, tagQuery]);

  if (hideWhenEmpty && allTags.length === 0) return null;

  const toggle = (tag: string) => {
    const next = new Set(selected);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    onChange(next);
  };

  return (
    <div data-anim className={cn("flex flex-wrap items-center gap-1.5", className ?? "mb-4")}>
      <button
        type="button"
        onClick={() => onChange(new Set())}
        className={cn(
          "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
          selected.size === 0 ? "border-primary bg-primary text-primary-foreground" : "border-border text-ink-2 hover:border-primary/40",
        )}
      >
        {t("toolbox.all")}
      </button>

      {searchable ? (
        <div className="relative mr-1">
          <Tag className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-ink-3" />
          <input
            value={tagQuery}
            onChange={(event) => setTagQuery(event.target.value)}
            placeholder={t("toolbox.tags.search")}
            className="h-7 w-32 rounded-full border border-border bg-surface pl-7 pr-2 text-[11px] text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-ink-3 focus:border-primary focus:shadow-[0_0_0_3px_var(--ring)]"
          />
        </div>
      ) : null}

      {visibleTags.map((tag) => (
        <button
          key={tag}
          type="button"
          onClick={() => toggle(tag)}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
            selected.has(tag)
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border text-ink-2 hover:border-primary/40 hover:text-primary",
          )}
        >
          {tag}
          {counts?.[tag] ? <span className="tabular-nums opacity-60">{counts[tag]}</span> : null}
        </button>
      ))}

      {selected.size >= 2 ? (
        <div className="ml-1 flex items-center gap-0.5 rounded-full border border-border bg-surface p-0.5">
          {(["or", "and"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onModeChange(m)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium outline-none transition-colors",
                mode === m ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
              )}
            >
              {m === "or" ? t("toolbox.tags.or") : t("toolbox.tags.and")}
            </button>
          ))}
        </div>
      ) : null}

      {selected.size > 0 ? (
        <span className="ml-1 text-[10px] text-ink-3">
          {t("toolbox.tags.selected", { n: selected.size })}
          {selected.size >= 2 ? ` · ${mode === "and" ? t("toolbox.tags.and") : t("toolbox.tags.or")}` : ""}
        </span>
      ) : null}
    </div>
  );
}
