import { useMemo, useState, type DragEvent } from "react";
import { ChevronDown, ChevronRight, FolderPlus, GripVertical, Pencil, Settings2, Search, Tag, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/ahub/lib/utils";
import { groupTags } from "@/ahub/lib/tag-groups";
import { useTagGroups } from "@/ahub/stores/tag-groups";
import type { TagMode } from "@/ahub/components/TagFilter";

const MODES: TagMode[] = ["or", "and"];

/**
 * 标签卡片仓（左侧竖栏）：分组区块 + 卡内多选。
 *
 * 为什么不是一条 `flex-wrap` 的标签墙：标签一多就铺满两行、和来源筛选抢同一层，
 * 用户既看不出「这些标签是什么维度」，也没法在一屏里收窄。
 *
 * 排版上刻意**不套卡片**：一层外框之内全是扁平区块 —— 分区标题一行、
 * 标签 chip 一行行排、区块之间用分隔线而不是第二层边框。
 * 侧栏这种窄栏里，嵌套盒子会把留白吃掉、让每一行都显得挤（Linear / Notion 的侧栏
 * 都是这个路子：一行一个区，不做卡片套卡片）。
 * 分组的新建 / 排序 / 改名 / 删除在「标签」页签里（这一栏只负责筛选），
 * 只有整理模式下才原地给出改名的入口。
 *
 * 数据侧只多了一张「标签 → 组」的映射（`useTagGroups`），标签本身仍是字符串，
 * 所以不需要迁移旧数据；删组只是把标签放回「未分组」。
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
  /** 打开治理台（标签页签）；没传就退回行内整理模式 */
  onManage?: () => void;
}) {
  const { t } = useTranslation();
  const groups = useTagGroups((s) => s.groups);
  const createGroup = useTagGroups((s) => s.create);
  const renameGroup = useTagGroups((s) => s.rename);
  const removeGroup = useTagGroups((s) => s.remove);
  const assignTag = useTagGroups((s) => s.assign);

  const [collapsed, setCollapsed] = useState(false);
  const [managing, setManaging] = useState(false);
  const [tagQuery, setTagQuery] = useState("");
  const [newGroup, setNewGroup] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const visible = useMemo(() => {
    const query = tagQuery.trim().toLowerCase();
    if (!query) return allTags;
    return allTags.filter((tag) => tag.toLowerCase().includes(query));
  }, [allTags, tagQuery]);

  const view = useMemo(() => groupTags(visible, groups), [visible, groups]);

  if (hideWhenEmpty && allTags.length === 0) return null;

  const toggle = (tag: string) => {
    const next = new Set(selected);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    onChange(next);
  };

  const drop = (event: DragEvent, groupId: string | null) => {
    event.preventDefault();
    const tag = event.dataTransfer.getData("text/plain");
    setDragOver(null);
    if (tag) assignTag(tag, groupId);
  };

  const chip = (tag: string, groupId: string | null) => {
    const count = counts?.[tag] ?? 0;
    const on = selected.has(tag);
    return (
      <button
        key={tag}
        type="button"
        draggable={managing}
        onDragStart={(event) => event.dataTransfer.setData("text/plain", tag)}
        onClick={() => toggle(tag)}
        title={managing ? t("tagShelf.dragHint") : undefined}
        className={cn(
          "group/chip inline-flex h-6 max-w-full items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors",
          on
            ? "border-primary/50 bg-primary-soft text-primary"
            : "border-border bg-surface text-ink-2 hover:border-primary/35 hover:text-foreground",
        )}
      >
        {managing ? <GripVertical className="size-2.5 shrink-0 text-ink-3" /> : null}
        <span className="truncate">{tag}</span>
        {count > 0 ? (
          <span className={cn("font-mono text-[10px]", on ? "text-primary/70" : "text-ink-3")}>{count}</span>
        ) : null}
        {managing && groupId ? (
          <span
            role="button"
            tabIndex={0}
            aria-label={t("tagShelf.removeFromGroup")}
            onClick={(event) => {
              event.stopPropagation();
              assignTag(tag, null);
            }}
            className="-mr-0.5 rounded p-0.5 text-ink-3 hover:bg-muted hover:text-foreground"
          >
            <X className="size-2.5" />
          </span>
        ) : null}
      </button>
    );
  };

  /** 一个分区：标题行 + 标签 chip。拖拽落点就是整个分区，不用瞄着标题。 */
  const section = (id: string | null, name: string, tags: string[]) => {
    const key = id ?? "__none";
    const isOver = dragOver === key;
    return (
      <section
        key={key}
        onDragOver={(event) => {
          if (!managing) return;
          event.preventDefault();
          setDragOver(key);
        }}
        onDragLeave={() => setDragOver(null)}
        onDrop={(event) => drop(event, id)}
        className={cn(
          "group/section flex flex-col gap-1 rounded-md px-1.5 py-1.5 transition-colors",
          isOver && "bg-primary-soft/50",
        )}
      >
        <header className="flex h-5 items-center gap-1.5">
          <span className={cn("size-1.5 shrink-0 rounded-[1px]", id ? "bg-primary/70" : "bg-ink-3")} />
          {editing?.id === id ? (
            <input
              autoFocus
              value={editing.name}
              onChange={(event) => setEditing({ id: id!, name: event.target.value })}
              onBlur={() => {
                renameGroup(id!, editing.name);
                setEditing(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  renameGroup(id!, editing.name);
                  setEditing(null);
                }
                if (event.key === "Escape") setEditing(null);
              }}
              className="h-5 min-w-0 flex-1 rounded border border-primary bg-surface px-1 text-[10.5px] outline-none"
            />
          ) : (
            <span className="truncate text-[10.5px] font-medium text-ink-2">{name}</span>
          )}
          <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-3">{tags.length}</span>
          {managing && id ? (
            <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/section:opacity-100">
              <button
                type="button"
                aria-label={t("tagShelf.rename")}
                onClick={() => setEditing({ id, name })}
                className="rounded p-0.5 text-ink-3 hover:text-foreground"
              >
                <Pencil className="size-2.5" />
              </button>
              <button
                type="button"
                aria-label={t("tagShelf.deleteGroup")}
                onClick={() => removeGroup(id)}
                className="rounded p-0.5 text-ink-3 hover:text-danger"
              >
                <X className="size-2.5" />
              </button>
            </span>
          ) : null}
        </header>
        {tags.length ? (
          <div className="flex flex-wrap gap-1">{tags.map((tag) => chip(tag, id))}</div>
        ) : (
          <p className="text-[10px] leading-4 text-ink-3">{t("tagShelf.emptyGroup")}</p>
        )}
      </section>
    );
  };

  return (
    <div className={cn("rounded-xl border border-border bg-surface/40", className)}>
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-ink-2 hover:text-foreground"
        >
          {collapsed ? <ChevronRight className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
          <Tag className="size-3 shrink-0" />
          <span className="truncate">{t("tagShelf.title")}</span>
          <span className="shrink-0 font-mono text-[10px] text-ink-3">{allTags.length}</span>
        </button>
        <button
          type="button"
          aria-label={t("tagShelf.manage")}
          data-testid="tag-shelf-manage"
          onClick={() => (onManage ? onManage() : setManaging((value) => !value))}
          className={cn(
            "ml-auto shrink-0 rounded p-0.5",
            managing && !onManage ? "text-primary" : "text-ink-3 hover:text-foreground",
          )}
        >
          <Settings2 className="size-3" />
        </button>
      </div>

      {collapsed ? null : (
        <>
          {allTags.length > 8 || tagQuery ? (
            <div className="flex items-center gap-1.5 border-t border-border/60 px-2 py-1.5">
              <div className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded border border-border px-1.5">
                <Search className="size-2.5 shrink-0 text-ink-3" />
                <input
                  value={tagQuery}
                  onChange={(event) => setTagQuery(event.target.value)}
                  placeholder={t("prompts.tagSearch")}
                  className="min-w-0 flex-1 bg-transparent text-[10.5px] outline-none placeholder:text-ink-3"
                />
              </div>
            </div>
          ) : null}

          {selected.size > 0 ? (
            <div className="flex flex-wrap items-center gap-1 border-t border-border/60 px-2 py-1.5">
              {[...selected].map((tag) => (
                <span
                  key={tag}
                  className="inline-flex h-5 items-center gap-1 rounded border border-primary/40 bg-primary-soft px-1.5 text-[10.5px] text-primary"
                >
                  {tag}
                  <button
                    type="button"
                    aria-label={`remove ${tag}`}
                    onClick={() => toggle(tag)}
                    className="rounded p-0.5 hover:bg-primary/15"
                  >
                    <X className="size-2" />
                  </button>
                </span>
              ))}
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
              <button
                type="button"
                onClick={() => onChange(new Set())}
                className="text-[10.5px] text-ink-3 hover:text-danger"
              >
                {t("common.clear")}
              </button>
            </div>
          ) : null}

          <div className="flex flex-col gap-0.5 border-t border-border/60 p-1">
            {view.groups.map((group) => section(group.id, group.name, group.tags))}
            {section(null, t("tagShelf.ungrouped"), view.ungrouped)}
            {managing ? (
              newGroup === null ? (
                <button
                  type="button"
                  onClick={() => setNewGroup("")}
                  className="mx-1.5 mt-0.5 flex h-7 items-center justify-center gap-1 rounded-md border border-dashed border-border text-[10.5px] text-ink-3 hover:border-primary/40 hover:text-primary"
                >
                  <FolderPlus className="size-3" />
                  {t("tagShelf.newGroup")}
                </button>
              ) : (
                <div className="mx-1.5 mt-0.5 flex items-center rounded-md border border-primary/40 px-2">
                  <input
                    autoFocus
                    value={newGroup}
                    onChange={(event) => setNewGroup(event.target.value)}
                    onBlur={() => {
                      if (newGroup.trim()) createGroup(newGroup);
                      setNewGroup(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        if (newGroup.trim()) createGroup(newGroup);
                        setNewGroup(null);
                      }
                      if (event.key === "Escape") setNewGroup(null);
                    }}
                    placeholder={t("tagShelf.groupName")}
                    className="h-7 min-w-0 flex-1 bg-transparent text-[10.5px] outline-none placeholder:text-ink-3"
                  />
                </div>
              )
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
