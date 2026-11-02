import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/ahub/lib/utils";
import type { TagMode } from "@/ahub/components/TagFilter";

const MODES: TagMode[] = ["or", "and"];

/**
 * 标签卡片仓（左侧竖栏）：平铺 + 卡内多选，**不做分组**。
 *
 * 分组曾经用来把标签按维度归并（"用途 / 来源 / 平台"），实际没人维护，
 * 反而让侧栏长出第二层结构、还要一套拖拽归组的手势。现在就是一层标签 chip：
 * 搜索、点选、or/and 切换，够用。
 *
 * 排版上刻意不套卡片、不画外框：整栏与场景栏共用同一套「栏」规则，
 * 底与圆角由页面那一层给（`<aside>`）。自己只负责 `flex-1 min-h-0` 与内部滚动，
 * 这样整栏高度由窗体决定，标签再多也不会把侧栏顶长。
 */
export function TagShelf({
  allTags,
  selected,
  onChange,
  mode,
  onModeChange,
  counts,
  className,
  hideWhenEmpty = true,
  onManage,
}: {
  allTags: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  mode: TagMode;
  onModeChange: (mode: TagMode) => void;
  counts?: Record<string, number>;
  className?: string;
  hideWhenEmpty?: boolean;
  /** 打开治理台（标签页签） */
  onManage?: () => void;
}) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [tagQuery, setTagQuery] = useState("");

  const visible = useMemo(() => {
    const query = tagQuery.trim().toLowerCase();
    const pool = query ? allTags.filter((tag) => tag.toLowerCase().includes(query)) : allTags;
    // 选中的排前面，其余按出现次数降序——常用的标签不用翻
    return [...pool].sort((a, b) => {
      const picked = Number(selected.has(b)) - Number(selected.has(a));
      return picked || (counts?.[b] ?? 0) - (counts?.[a] ?? 0) || a.localeCompare(b);
    });
  }, [allTags, tagQuery, counts, selected]);

  if (hideWhenEmpty && allTags.length === 0) return null;

  const toggle = (tag: string) => {
    const next = new Set(selected);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    onChange(next);
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex h-6 shrink-0 items-center gap-1.5 px-1.5">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex min-w-0 items-center gap-1.5 text-[10.5px] font-medium text-ink-3 outline-none transition-colors hover:text-foreground"
        >
          {collapsed ? <ChevronRight className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
          <span className="truncate">{t("tagShelf.title")}</span>
          <span className="shrink-0 tabular-nums">{allTags.length}</span>
        </button>
        {onManage ? (
          <button
            type="button"
            aria-label={t("tagShelf.manage")}
            data-testid="tag-shelf-manage"
            onClick={onManage}
            className="ml-auto shrink-0 rounded p-0.5 text-ink-3 outline-none transition-colors hover:text-foreground"
          >
            <Settings2 className="size-3" />
          </button>
        ) : null}
      </div>

      {collapsed ? null : (
        <>
          {allTags.length > 8 || tagQuery ? (
            <div className="flex shrink-0 items-center gap-1.5 px-1.5 pt-0.5 pb-1">
              <div className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border px-1.5">
                <Search className="size-2.5 shrink-0 text-ink-3" />
                <input
                  value={tagQuery}
                  onChange={(event) => setTagQuery(event.target.value)}
                  placeholder={t("prompts.tagSearch")}
                  className="min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-ink-3"
                />
              </div>
            </div>
          ) : null}

          {selected.size > 0 ? (
            <div className="flex shrink-0 flex-wrap items-center gap-1 px-1.5 pt-0.5 pb-1">
              <div className="flex items-center overflow-hidden rounded border border-border">
                {MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => onModeChange(m)}
                    className={cn(
                      "px-1.5 py-0.5 text-[10px] font-medium",
                      mode === m ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
                    )}
                  >
                    {m === "or" ? t("common.tagOr") : t("common.tagAnd")}
                  </button>
                ))}
              </div>
              <span className="text-[10.5px] tabular-nums text-ink-3">
                {t("tagShelf.selectedCount", { n: selected.size })}
              </span>
              <button
                type="button"
                onClick={() => onChange(new Set())}
                className="ml-auto text-[10.5px] text-ink-3 hover:text-danger"
              >
                {t("common.clear")}
              </button>
            </div>
          ) : null}

          {/* 标签区自己滚：整栏高度由窗体决定，标签再多也不把侧栏顶长 */}
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1">
            {visible.length ? (
              <div className="flex flex-wrap gap-1">
                {visible.map((tag) => {
                  const count = counts?.[tag] ?? 0;
                  const on = selected.has(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggle(tag)}
                      className={cn(
                        "inline-flex h-6 max-w-full items-center gap-1 rounded-md border px-2 text-[11px] transition-colors",
                        on
                          ? "border-primary/50 bg-primary-soft font-medium text-primary"
                          : "border-border bg-surface text-ink-2 hover:border-primary/35 hover:text-foreground",
                      )}
                    >
                      <span className="truncate">{tag}</span>
                      {count > 0 ? (
                        <span className={cn("text-[10.5px] tabular-nums", on ? "text-primary/70" : "text-ink-3")}>{count}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="px-1 py-1 text-[10.5px] leading-4 text-ink-3">{t("tagShelf.noMatch")}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
