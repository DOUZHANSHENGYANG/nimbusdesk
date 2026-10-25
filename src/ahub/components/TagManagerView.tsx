import { useMemo, useState } from "react";
import { Check, FolderPlus, Pencil, Search, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/ahub/lib/utils";
import { useTagGroups } from "@/ahub/stores/tag-groups";

/**
 * 标签页（C 底座）：左侧分组、中间表格、右侧命中。
 *
 * 标签**不可编辑**：它来自技能 / MCP / 提示词里用户自己写的那串字符串，
 * 在这里改名会静默改掉一堆条目的标签，用户根本不知道发生了什么。
 * 这里只做两件事：给标签**归组**（单条下拉或勾选后批量归组）、管理**分组**本身（增 / 改 / 删）。
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

  const [scope, setScope] = useState("all");
  const [query, setQuery] = useState("");
  const [newGroup, setNewGroup] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchGroup, setBatchGroup] = useState("");

  const groupOf = (tag: string) => groups.find((group) => group.tags.includes(tag)) ?? null;
  const totalUses = useMemo(() => allTags.reduce((sum, tag) => sum + (counts?.[tag] ?? 0), 0), [allTags, counts]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allTags
      .filter((tag) => (q ? tag.toLowerCase().includes(q) : true))
      .filter((tag) => {
        if (scope === "all") return true;
        if (scope === "none") return !groupOf(tag);
        return groupOf(tag)?.id === scope;
      })
      .sort((a, b) => (counts?.[b] ?? 0) - (counts?.[a] ?? 0) || a.localeCompare(b));
  }, [allTags, query, scope, groups, counts]);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[176px_minmax(0,1fr)_212px] gap-3">
      <nav className="flex flex-col gap-0.5">
        <p className="px-2 pb-1 text-[10.5px] uppercase tracking-wider text-ink-3">{t("tagManager.groups")}</p>

        {[
          { id: "all", label: t("tagManager.all"), n: allTags.length },
          ...groups.map((group) => ({ id: group.id, label: group.name, n: group.tags.filter((tag) => allTags.includes(tag)).length })),
          { id: "none", label: t("tagShelf.ungrouped"), n: allTags.filter((tag) => !groupOf(tag)).length },
        ].map((item) => {
          const isGroup = item.id !== "all" && item.id !== "none";
          const row = (
            <div key={item.id} className="group/row flex items-center">
              {editing?.id === item.id ? (
                <input
                  autoFocus
                  value={editing.name}
                  onChange={(event) => setEditing({ id: item.id, name: event.target.value })}
                  onBlur={() => {
                    renameGroup(item.id, editing.name);
                    setEditing(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      renameGroup(item.id, editing.name);
                      setEditing(null);
                    }
                    if (event.key === "Escape") setEditing(null);
                  }}
                  className="h-8 w-full rounded-md border border-primary bg-transparent px-2 text-[12px] outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setScope(item.id)}
                  className={cn(
                    "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-[12px]",
                    scope === item.id ? "bg-primary-soft text-primary" : "text-ink-2 hover:bg-muted",
                  )}
                >
                  <span className="truncate">{item.label}</span>
                  <span className="ml-auto font-mono text-[10px] text-ink-3">{item.n}</span>
                </button>
              )}
              {isGroup && editing?.id !== item.id ? (
                confirming === item.id ? (
                  <span className="ml-1 flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      aria-label={t("tagManager.confirmDelete")}
                      onClick={() => {
                        removeGroup(item.id);
                        if (scope === item.id) setScope("all");
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
                  <span className="ml-1 flex shrink-0 items-center opacity-0 transition-opacity group-hover/row:opacity-100">
                    <button
                      type="button"
                      aria-label={t("tagShelf.rename")}
                      onClick={() => setEditing({ id: item.id, name: item.label })}
                      className="rounded p-0.5 text-ink-3 hover:text-foreground"
                    >
                      <Pencil className="size-2.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={t("tagShelf.deleteGroup")}
                      onClick={() => setConfirming(item.id)}
                      className="rounded p-0.5 text-ink-3 hover:text-danger"
                    >
                      <Trash2 className="size-2.5" />
                    </button>
                  </span>
                )
              ) : null}
            </div>
          );
          return row;
        })}

        {newGroup === null ? (
          <button
            type="button"
            onClick={() => setNewGroup("")}
            className="mt-1 flex h-8 items-center gap-1.5 rounded-md border border-dashed border-border px-2 text-[11.5px] text-ink-3 hover:border-primary/40 hover:text-primary"
          >
            <FolderPlus className="size-3" />
            {t("tagShelf.newGroup")}
          </button>
        ) : (
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
            className="mt-1 h-8 rounded-md border border-primary bg-transparent px-2 text-[11.5px] outline-none"
          />
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
            <select
              value={batchGroup}
              onChange={(event) => setBatchGroup(event.target.value)}
              className="h-6 rounded border border-border bg-surface px-1 text-[10.5px] text-ink-2 outline-none"
            >
              <option value="">{t("tagShelf.ungrouped")}</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
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
          {rows.map((tag) => {
            const group = groupOf(tag);
            return (
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
                <select
                  value={group?.id ?? ""}
                  onChange={(event) => assignTag(tag, event.target.value || null)}
                  className="h-6 max-w-full rounded border border-border bg-transparent px-1 text-[10.5px] text-ink-2 outline-none"
                >
                  <option value="">{t("tagShelf.ungrouped")}</option>
                  {groups.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <span className="text-right font-mono text-[10.5px] text-ink-3">{counts?.[tag] ?? 0}</span>
              </div>
            );
          })}
          {rows.length === 0 ? <p className="px-3 py-8 text-center text-[11.5px] text-ink-3">{t("tagManager.empty")}</p> : null}
        </div>

        <p className="text-[10.5px] leading-4 text-ink-3">{t("tagManager.tagReadonly")}</p>
      </section>

      <aside className="rounded-lg border border-border bg-surface/60 p-2.5">
        <p className="text-[11px] text-ink-3">{t("tagManager.sideTitle")}</p>
        <p className="mt-1 font-mono text-[22px] text-foreground">{resultCount ?? 0}</p>
        <p className="mt-0.5 text-[10.5px] leading-4 text-ink-3">{t("tagManager.sideHint")}</p>
        <div className="mt-3 border-t border-border/60 pt-2 text-[10.5px] leading-5 text-ink-3">
          <p>{t("tagManager.sideStats", { tags: allTags.length, groups: groups.length, uses: totalUses })}</p>
        </div>
      </aside>
    </div>
  );
}
