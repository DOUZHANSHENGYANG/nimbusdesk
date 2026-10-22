import { Tag } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/ahub/lib/utils";

export type TagMode = "or" | "and";

/** 判断一组标签是否满足所选标签的与/或条件 */
export function matchTags(itemTags: string[], selected: Set<string>, mode: TagMode): boolean {
  if (selected.size === 0) return true;
  const has = (t: string) => itemTags.includes(t);
  if (mode === "and") return [...selected].every(has);
  return [...selected].some(has);
}

/**
 * 标签筛选条：支持多选叠加，以及与/或逻辑切换。
 * 选中的标签在「与」模式下需全部命中，「或」模式下命中任意一个即可。
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
  /** 是否显示标签搜索框（标签很多时用） */
  searchable?: boolean;
  /** 外层容器 class（默认 mb-4，嵌入其他面板时传 "" 去掉） */
  className?: string;
  /** 标签 → 数量，已在胶囊右侧以弱化色显示 */
  counts?: Record<string, number>;
  /**
   * 无标签时是否隐藏整条。
   * 默认 true（保持原行为）；页面级筛选栏应传 false ——
   * 否则「没有任何标签」时用户根本不知道这里能按标签筛。
   */
  hideWhenEmpty?: boolean;
}) {
  const { t } = useTranslation();
  const [tagQuery, setTagQuery] = useState("");

  const visibleTags = useMemo(() => {
    const q = tagQuery.trim().toLowerCase();
    if (!q) return allTags;
    return allTags.filter((tg) => tg.toLowerCase().includes(q));
  }, [allTags, tagQuery]);

  if (hideWhenEmpty && allTags.length === 0) return null;

  const toggle = (tg: string) => {
    const next = new Set(selected);
    if (next.has(tg)) next.delete(tg);
    else next.add(tg);
    onChange(next);
  };

  return (
    <div data-anim className={cn("flex flex-wrap items-center gap-1.5", className ?? "mb-4")}>
      <button
        type="button"
        onClick={() => onChange(new Set())}
        className={cn(
          "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
          selected.size === 0 ? "border-primary bg-primary text-white" : "border-border text-ink-2 hover:border-primary/40",
        )}
      >
        {t("common.all")}
      </button>

      {searchable ? (
        <div className="relative mr-1">
          <Tag className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-ink-3" />
          <input
            value={tagQuery}
            onChange={(e) => setTagQuery(e.target.value)}
            placeholder={t("prompts.tagSearch")}
            className="h-7 w-32 rounded-full border border-border bg-surface pl-7 pr-2 text-[11px] text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-ink-3 focus:border-primary focus:shadow-[0_0_0_3px_var(--ah-primary-soft)]"
          />
        </div>
      ) : null}

      {visibleTags.map((tg) => (
        <button
          key={tg}
          type="button"
          onClick={() => toggle(tg)}
          className={cn(
            "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
            selected.has(tg)
              ? "border-primary bg-primary text-white"
              : "border-border text-ink-2 hover:border-primary/40 hover:text-primary",
          )}
        >
          {tg}
          {counts && counts[tg] ? <span className="tabular-nums opacity-60">{counts[tg]}</span> : null}
        </button>
      ))}

      {/* 与/或 逻辑切换（选中 ≥2 个标签时才显示） */}
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
              {m === "or" ? t("common.tagOr") : t("common.tagAnd")}
            </button>
          ))}
        </div>
      ) : null}

      {selected.size > 0 ? (
        <span className="ml-1 text-[10px] text-ink-3">
          {t("common.tagSelected", { n: selected.size })}
          {selected.size >= 2 ? ` · ${mode === "and" ? t("common.tagAnd") : t("common.tagOr")}` : ""}
        </span>
      ) : null}
    </div>
  );
}
