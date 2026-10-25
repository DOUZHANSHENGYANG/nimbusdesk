import { useMemo, useState } from "react";
import { FolderPlus, Pencil, Search, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/ahub/lib/utils";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/ahub/components/ui/dialog";
import { useTagGroups } from "@/ahub/stores/tag-groups";

/**
 * 标签治理台（C 底座）：左侧分组、右侧按组分节的表。
 *
 * 这里只改「标签 → 组」的映射；改名/删除标签要重写条目，交给页面传进来的
 * `onRenameTag` / `onDeleteTag`（技能走 saveSkill、MCP 走 saveMcp、提示词走 savePrompt）。
 */
export function TagManagerDialog({
  open,
  onOpenChange,
  allTags,
  counts,
  onRenameTag,
  onDeleteTag,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allTags: string[];
  counts?: Record<string, number>;
  onRenameTag?: (from: string, to: string) => Promise<void> | void;
  onDeleteTag?: (tag: string) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const groups = useTagGroups((s) => s.groups);
  const createGroup = useTagGroups((s) => s.create);
  const removeGroup = useTagGroups((s) => s.remove);
  const assignTag = useTagGroups((s) => s.assign);

  const [scope, setScope] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [newGroup, setNewGroup] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ tag: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const groupOf = (tag: string) => groups.find((g) => g.tags.includes(tag)) ?? null;

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

  const totalUses = useMemo(() => allTags.reduce((sum, tag) => sum + (counts?.[tag] ?? 0), 0), [allTags, counts]);

  const commitRename = async () => {
    if (!renaming) return;
    const from = renaming.tag;
    const to = renaming.value.trim();
    setRenaming(null);
    if (!to || to === from) return;
    setBusy(true);
    try {
      await onRenameTag?.(from, to);
      const group = groupOf(from);
      if (group) assignTag(to, group.id);
      assignTag(from, null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide className="sm:max-w-[900px]">
        <DialogHeader>
          <DialogTitle>{t("tagManager.title")}</DialogTitle>
          <DialogDescription>
            {t("tagManager.subtitle", { tags: allTags.length, groups: groups.length, uses: totalUses })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid grid-cols-[148px_minmax(0,1fr)] gap-3">
            <nav className="flex flex-col gap-0.5">
              {[
                { id: "all", label: t("tagManager.all"), n: allTags.length },
                ...groups.map((group) => ({ id: group.id, label: group.name, n: group.tags.filter((tag) => allTags.includes(tag)).length })),
                { id: "none", label: t("tagShelf.ungrouped"), n: allTags.filter((tag) => !groupOf(tag)).length },
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setScope(item.id)}
                  className={cn(
                    "flex h-8 items-center gap-2 rounded-md px-2 text-[12px]",
                    scope === item.id ? "bg-primary-soft text-primary" : "text-ink-2 hover:bg-muted",
                  )}
                >
                  <span className="truncate">{item.label}</span>
                  <span className="ml-auto font-mono text-[10px] text-ink-3">{item.n}</span>
                </button>
              ))}
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
                  className="mt-1 h-8 rounded-md border border-primary px-2 text-[11.5px] outline-none"
                />
              )}
            </nav>

            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-2">
                <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border px-2">
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

              <div className="max-h-[340px] overflow-y-auto rounded-lg border border-border">
                <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_120px_54px_56px] gap-2 border-b border-border bg-surface-2 px-2 py-1.5 text-[10.5px] text-ink-3">
                  <span>{t("tagManager.columnTag")}</span>
                  <span>{t("tagManager.columnGroup")}</span>
                  <span className="text-right">{t("tagManager.columnUses")}</span>
                  <span className="text-right">{t("tagManager.columnActions")}</span>
                </div>
                {rows.map((tag) => {
                  const group = groupOf(tag);
                  return (
                    <div key={tag} className="grid grid-cols-[minmax(0,1fr)_120px_54px_56px] items-center gap-2 border-b border-border/60 px-2 py-1.5 text-[11.5px] last:border-0">
                      {renaming?.tag === tag ? (
                        <input
                          autoFocus
                          value={renaming.value}
                          onChange={(event) => setRenaming({ tag, value: event.target.value })}
                          onBlur={() => void commitRename()}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void commitRename();
                            if (event.key === "Escape") setRenaming(null);
                          }}
                          className="h-6 rounded border border-primary px-1.5 text-[11.5px] outline-none"
                        />
                      ) : (
                        <span className="truncate text-foreground">{tag}</span>
                      )}

                      <select
                        value={group?.id ?? ""}
                        onChange={(event) => assignTag(tag, event.target.value || null)}
                        className="h-6 max-w-full rounded border border-border bg-surface px-1 text-[10.5px] text-ink-2 outline-none"
                      >
                        <option value="">{t("tagShelf.ungrouped")}</option>
                        {groups.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>

                      <span className="text-right font-mono text-[10.5px] text-ink-3">{counts?.[tag] ?? 0}</span>

                      <span className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          aria-label={t("tagShelf.rename")}
                          onClick={() => setRenaming({ tag, value: tag })}
                          disabled={!onRenameTag || busy}
                          className="rounded p-0.5 text-ink-3 hover:text-foreground disabled:opacity-30"
                        >
                          <Pencil className="size-3" />
                        </button>
                        <button
                          type="button"
                          aria-label={t("tagManager.deleteTag")}
                          onClick={() => void onDeleteTag?.(tag)}
                          disabled={!onDeleteTag || busy}
                          className="rounded p-0.5 text-ink-3 hover:text-danger disabled:opacity-30"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </span>
                    </div>
                  );
                })}
                {rows.length === 0 ? <p className="px-3 py-6 text-center text-[11.5px] text-ink-3">{t("tagManager.empty")}</p> : null}
              </div>

              {groups.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {groups.map((group) => (
                    <span key={group.id} className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10.5px] text-ink-2">
                      {group.name}
                      <button
                        type="button"
                        aria-label={t("tagShelf.deleteGroup")}
                        onClick={() => removeGroup(group.id)}
                        className="rounded p-0.5 text-ink-3 hover:text-danger"
                      >
                        <X className="size-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
