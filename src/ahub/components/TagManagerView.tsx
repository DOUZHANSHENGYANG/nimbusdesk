import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronRight, FolderPlus, Pencil, Search, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/ahub/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ahub/components/ui/select";
import { useTagGroups } from "@/ahub/stores/tag-groups";

/**
 * 标签页（C 底座）：左侧分组、中间按分区分组的标签表、右侧命中。
 *
 * 标签**不可编辑**：它来自技能 / MCP / 提示词里用户自己写的那串字符串，
 * 在这里改名会静默改掉一堆条目的标签，用户根本不知道发生了什么。
 * 所以这里只做两件事：给标签**归组**、管理**分组**本身（增 / 改 / 删 / 排序）。
 *
 * 建组有三个入口，走的都是同一套「建完立刻归位」的流程：
 *   1. 左栏底部「＋ 新建分组」—— 先建一个空组（组本身也是可排序的一等对象）；
 *   2. 批量栏「新建分组并移入」—— 选中若干标签后一步建组 + 归组；
 *   3. 行内下拉最后一项「＋ 新建分组…」—— 这一条直接进新组。
 * 参考的是 Linear 的 label groups（在使用处建组）、Gmail 的 Create new label、
 * TagSpaces 的分组可排序，以及 Reduct 用折叠分区把「组间搬运」变简单。
 */
export function TagManagerView({
  allTags,
  counts,
  resultCount,
}: {
  allTags: string[];
  counts?: Record<string, number>;
  resultCount?: number;
  /** 兼容旧调用：标签不可编辑，这两个回调不再使用 */
  onRenameTag?: (from: string, to: string) => Promise<void> | void;
  onDeleteTag?: (tag: string) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const groups = useTagGroups((s) => s.groups);
  const createGroup = useTagGroups((s) => s.create);
  const renameGroup = useTagGroups((s) => s.rename);
  const removeGroup = useTagGroups((s) => s.remove);
  const assignTag = useTagGroups((s) => s.assign);
  const moveGroup = useTagGroups((s) => s.move);

  const [scope, setScope] = useState("all");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** 正在输入名字的新建分组：target = "nav"（左栏）/ "batch"（批量栏）/ 标签名（行内） */
  const [draft, setDraft] = useState<{ target: string; name: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchGroup, setBatchGroup] = useState("");

  const groupOf = (tag: string) => groups.find((group) => group.tags.includes(tag)) ?? null;
  const totalUses = useMemo(() => allTags.reduce((sum, tag) => sum + (counts?.[tag] ?? 0), 0), [allTags, counts]);

  /** 分区：按分组顺序排（最后永远是「未分组」）；筛选只影响每个分区里的标签，不隐藏分区本身 */
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (tag: string) => (q ? tag.toLowerCase().includes(q) : true);
    const known = new Set(allTags);
    const sort = (list: string[]) =>
      [...list].sort((a, b) => (counts?.[b] ?? 0) - (counts?.[a] ?? 0) || a.localeCompare(b));
    const out = [
      ...groups.map((group) => ({
        id: group.id,
        name: group.name,
        tags: sort(group.tags.filter((tag) => known.has(tag) && hit(tag))),
      })),
      {
        id: "none",
        name: t("tagShelf.ungrouped"),
        tags: sort(allTags.filter((tag) => !groupOf(tag) && hit(tag))),
      },
    ];
    return scope === "all" ? out : out.filter((section) => section.id === scope);
  }, [groups, allTags, counts, query, scope, t]);

  const rows = useMemo(() => sections.flatMap((section) => section.tags), [sections]);
  /** 有搜索词时强制展开：搜出来的东西藏在折叠分区里等于没搜 */
  const isCollapsed = (id: string) => !query.trim() && collapsed.has(id);

  const toggleSection = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** 三个入口共用的收尾：建组 →（批量栏带走选中项 / 行内带走这一条）→ 清状态 */
  const commitDraft = () => {
    if (!draft) return;
    const { target } = draft;
    const name = draft.name.trim();
    setDraft(null);
    if (!name) return;
    const id = createGroup(name);
    if (target === "batch") {
      for (const tag of selected) assignTag(tag, id);
      setSelected(new Set());
    } else if (target !== "nav") {
      assignTag(target, id);
    }
  };

  const draftInput = (target: string, className?: string) => (
    <input
      autoFocus
      value={draft?.target === target ? draft.name : ""}
      onChange={(event) => setDraft({ target, name: event.target.value })}
      onBlur={commitDraft}
      onKeyDown={(event) => {
        if (event.key === "Enter") commitDraft();
        if (event.key === "Escape") setDraft(null);
      }}
      placeholder={t("tagShelf.groupName")}
      className={cn("h-6 rounded-md border border-primary bg-transparent px-2 text-[11px] outline-none", className)}
    />
  );

  const groupRow = (id: string, label: string, count: number) => {
    const isReal = id !== "all" && id !== "none";
    const index = isReal ? groups.findIndex((group) => group.id === id) : -1;
    return (
      <div key={id} className="group/row flex items-center">
        {editing?.id === id ? (
          <input
            autoFocus
            value={editing.name}
            onChange={(event) => setEditing({ id, name: event.target.value })}
            onBlur={() => {
              renameGroup(id, editing.name);
              setEditing(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                renameGroup(id, editing.name);
                setEditing(null);
              }
              if (event.key === "Escape") setEditing(null);
            }}
            className="h-8 w-full rounded-md border border-primary bg-transparent px-2 text-[12px] outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setScope(id)}
            className={cn(
              "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-[12px]",
              scope === id ? "bg-primary-soft text-primary" : "text-ink-2 hover:bg-muted",
            )}
          >
            <span className="truncate">{label}</span>
            <span className="ml-auto font-mono text-[10px] text-ink-3">{count}</span>
          </button>
        )}
        {isReal && editing?.id !== id ? (
          confirming === id ? (
            <span className="ml-1 flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                aria-label={t("tagManager.confirmDelete")}
                onClick={() => {
                  removeGroup(id);
                  if (scope === id) setScope("all");
                  setConfirming(null);
                }}
                className="rounded p-0.5 text-danger"
              >
                <Check className="size-3" />
              </button>
              <button type="button" aria-label={t("common.cancel")} onClick={() => setConfirming(null)} className="rounded p-0.5 text-ink-3">
                <X className="size-3" />
              </button>
            </span>
          ) : (
            <span className="ml-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100">
              <button
                type="button"
                aria-label={t("tagManager.moveUp")}
                disabled={index <= 0}
                onClick={() => moveGroup(id, -1)}
                className="rounded p-0.5 text-ink-3 hover:text-foreground disabled:opacity-30"
              >
                <ArrowUp className="size-2.5" />
              </button>
              <button
                type="button"
                aria-label={t("tagManager.moveDown")}
                disabled={index === groups.length - 1}
                onClick={() => moveGroup(id, 1)}
                className="rounded p-0.5 text-ink-3 hover:text-foreground disabled:opacity-30"
              >
                <ArrowDown className="size-2.5" />
              </button>
              <button
                type="button"
                aria-label={t("tagShelf.rename")}
                onClick={() => setEditing({ id, name: label })}
                className="rounded p-0.5 text-ink-3 hover:text-foreground"
              >
                <Pencil className="size-2.5" />
              </button>
              <button
                type="button"
                aria-label={t("tagShelf.deleteGroup")}
                onClick={() => setConfirming(id)}
                className="rounded p-0.5 text-ink-3 hover:text-danger"
              >
                <Trash2 className="size-2.5" />
              </button>
            </span>
          )
        ) : null}
      </div>
    );
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[176px_minmax(0,1fr)_212px] gap-3">
      <nav className="flex flex-col gap-0.5">
        <p className="px-2 pb-1 text-[10.5px] uppercase tracking-wider text-ink-3">{t("tagManager.groups")}</p>

        {groupRow("all", t("tagManager.all"), allTags.length)}
        {groups.map((group) =>
          groupRow(group.id, group.name, group.tags.filter((tag) => allTags.includes(tag)).length),
        )}
        {groupRow("none", t("tagShelf.ungrouped"), allTags.filter((tag) => !groupOf(tag)).length)}

        {draft?.target === "nav" ? (
          draftInput("nav", "mt-1 h-8 w-full")
        ) : (
          <button
            type="button"
            onClick={() => setDraft({ target: "nav", name: "" })}
            className="mt-1 flex h-8 items-center gap-1.5 rounded-md border border-dashed border-border px-2 text-[11.5px] text-ink-3 hover:border-primary/40 hover:text-primary"
          >
            <FolderPlus className="size-3" />
            {t("tagShelf.newGroup")}
          </button>
        )}
      </nav>

      <section className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border px-2">
            <Search className="size-3 text-ink-3" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("tagManager.search")}
              className="min-w-0 flex-1 bg-transparent text-[11.5px] outline-none placeholder:text-ink-3"
            />
          </div>
          <span className="font-mono text-[10px] text-ink-3">{rows.length}</span>
        </div>

        {selected.size > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-2 py-1.5 text-[11px]">
            <span className="text-foreground">{t("tagManager.batchSelected", { n: selected.size })}</span>
            {draft?.target === "batch" ? (
              draftInput("batch", "w-[140px]")
            ) : (
              <>
                <button
                  type="button"
                  className="h-6 rounded border border-primary/40 bg-primary px-2 text-[10.5px] text-primary-foreground"
                  onClick={() => setDraft({ target: "batch", name: "" })}
                >
                  {t("tagManager.newGroupWithSelection")}
                </button>
                <Select
                  value={batchGroup || "__none"}
                  onValueChange={(value) => setBatchGroup(value === "__none" ? "" : value)}
                >
                  <SelectTrigger className="h-6 w-[112px] text-[10.5px]" aria-label={t("tagManager.columnGroup")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">{t("tagShelf.ungrouped")}</SelectItem>
                    {groups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  className="h-6 rounded border border-primary/40 bg-primary px-2 text-[10.5px] text-primary-foreground"
                  onClick={() => {
                    for (const tag of selected) assignTag(tag, batchGroup || null);
                    setSelected(new Set());
                  }}
                >
                  {t("tagManager.batchAssign")}
                </button>
                <button
                  type="button"
                  className="h-6 rounded px-1 text-[10.5px] text-ink-3 hover:text-foreground"
                  onClick={() => setSelected(new Set())}
                >
                  {t("tagManager.batchClear")}
                </button>
              </>
            )}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border">
          <div className="sticky top-0 z-10 grid grid-cols-[24px_minmax(0,1fr)_150px_60px] gap-2 border-b border-border bg-surface-2 px-2.5 py-1.5 text-[10.5px] text-ink-3">
            <input
              type="checkbox"
              aria-label={t("tagManager.batchSelectAll")}
              className="size-3 self-center accent-primary"
              checked={rows.length > 0 && rows.every((tag) => selected.has(tag))}
              onChange={(event) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (event.target.checked) rows.forEach((tag) => next.add(tag));
                  else rows.forEach((tag) => next.delete(tag));
                  return next;
                })
              }
            />
            <span>{t("tagManager.columnTag")}</span>
            <span>{t("tagManager.columnGroup")}</span>
            <span className="text-right">{t("tagManager.columnUses")}</span>
          </div>

          {sections.map((section) => {
            const shut = isCollapsed(section.id);
            return (
              <div key={section.id}>
                <button
                  type="button"
                  aria-expanded={!shut}
                  onClick={() => toggleSection(section.id)}
                  className="flex w-full items-center gap-1.5 border-b border-border/60 bg-surface-2/60 px-2.5 py-1.5 text-left outline-none hover:bg-muted/40"
                >
                  <ChevronRight className={cn("size-3 shrink-0 text-ink-3 transition-transform", !shut && "rotate-90")} />
                  <span className="truncate text-[11px] font-semibold text-ink-2">{section.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-ink-3">{section.tags.length}</span>
                </button>

                {shut
                  ? null
                  : section.tags.map((tag) => (
                      <div
                        key={tag}
                        className="grid grid-cols-[24px_minmax(0,1fr)_150px_60px] items-center gap-2 border-b border-border/60 px-2.5 py-1.5 text-[11.5px] last:border-0 hover:bg-muted/40"
                      >
                        <input
                          type="checkbox"
                          aria-label={t("tagManager.batchSelectTag", { tag })}
                          className="size-3 accent-primary"
                          checked={selected.has(tag)}
                          onChange={(event) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(tag);
                              else next.delete(tag);
                              return next;
                            })
                          }
                        />
                        <span className="truncate text-foreground">{tag}</span>
                        {draft?.target === tag ? (
                          draftInput(tag, "max-w-full")
                        ) : (
                          <Select
                            value={groupOf(tag)?.id ?? "__none"}
                            onValueChange={(value) => {
                              if (value === "__new") setDraft({ target: tag, name: "" });
                              else assignTag(tag, value === "__none" ? null : value);
                            }}
                          >
                            <SelectTrigger className="h-6 w-full text-[10.5px]" aria-label={t("tagManager.columnGroup")}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none">{t("tagShelf.ungrouped")}</SelectItem>
                              {groups.map((group) => (
                                <SelectItem key={group.id} value={group.id}>
                                  {group.name}
                                </SelectItem>
                              ))}
                              {/* 最后一项现场建组：这一条直接进新组 */}
                              <SelectItem value="__new" className="text-primary">
                                {t("tagManager.newGroupInline")}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                        <span className="text-right font-mono text-[10.5px] text-ink-3">{counts?.[tag] ?? 0}</span>
                      </div>
                    ))}

                {!shut && section.tags.length === 0 ? (
                  <p className="px-2.5 py-2 text-[10.5px] text-ink-3">—</p>
                ) : null}
              </div>
            );
          })}

          {rows.length === 0 ? (
            <p className="px-3 py-8 text-center text-[11.5px] text-ink-3">{t("tagManager.empty")}</p>
          ) : null}
        </div>
      </section>

      <aside className="rounded-lg border border-border bg-surface/60 p-2.5">
        <p className="text-[11px] text-ink-3">{t("tagManager.sideTitle")}</p>
        <p className="mt-1 font-mono text-[22px] text-foreground">{resultCount ?? 0}</p>
        <div className="mt-3 border-t border-border/60 pt-2 text-[10.5px] leading-5 text-ink-3">
          <p>{t("tagManager.sideStats", { tags: allTags.length, groups: groups.length, uses: totalUses })}</p>
        </div>
      </aside>
    </div>
  );
}
