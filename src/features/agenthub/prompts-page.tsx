import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Archive,
  CloudUpload,
  Columns2,
  Copy,
  Eye,
  FileText,
  History,
  LayoutGrid,
  PencilLine,
  Plus,
  Rows3,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { tbPromptDelete, tbPromptList, tbPromptRestore, tbPromptSave, type TbPrompt, type TbVersion } from "./api";
import { collectTags, matchQuery, matchTags, timeLabel, type TagMode } from "./core";
import { ConfirmDialog } from "./confirm";
import { ToolboxPage } from "./page";
import { EmptyState } from "./shared/empty-state";
import { Field, Input, Textarea } from "./shared/form";
import { MarkdownView } from "./shared/markdown";
import { FilterBar, SearchBar } from "./shared/search-bar";
import { TagFilter } from "./shared/tag-filter";
import { TagInput } from "./shared/tag-input";
import { VersionList } from "./shared/version-list";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./shared/dialog";
import "./toolbox.css";

/** 正文区的三种呈现方式：纯编辑 / 纯预览 / 左右分栏对照 */
type ContentMode = "edit" | "preview" | "split";

const CONTENT_MODES: { id: ContentMode; icon: typeof Eye; key: string }[] = [
  { id: "edit", icon: PencilLine, key: "toolbox.modeEdit" },
  { id: "preview", icon: Eye, key: "toolbox.modePreview" },
  { id: "split", icon: Columns2, key: "toolbox.modeSplit" },
];

function blank(): TbPrompt {
  return { id: "", title: "", description: "", content: "", tags: [], versions: [], createdAt: "", updatedAt: "" };
}

/**
 * 提示词页。
 *
 * 与源侧的差异只有两处，都是为了不留半成品：
 * - 源侧除「卡片网格」外还有一条「预览」路径（左侧列表 + 右侧只读面板，面板里
 *   再嵌一层预览/编辑切换）——那层切换的按钮连选中态样式都没写，且与编辑弹窗里
 *   的三态切换重复。这里把视图开关收敛成「卡片 / 列表」，两种都进同一个编辑弹窗。
 * - 变量面板（PromptVars）是后端缺口（`{{var}}` 的解析/渲染在云台 Rust 侧还没实现），
 *   所以侧栏只留版本时间轴，没有放一个点了没反应的变量区。
 */
export function PromptsPage() {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<TbPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");

  const [query, setQuery] = useState("");
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [tagMode, setTagMode] = useState<TagMode>("or");
  const [view, setView] = useState<"grid" | "list">("grid");

  /** 已落盘的那一份；draft 是编辑中的副本。两者不一致才允许保存。 */
  const [saved, setSaved] = useState<TbPrompt | null>(null);
  const [draft, setDraft] = useState<TbPrompt | null>(null);
  const [contentMode, setContentMode] = useState<ContentMode>("edit");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<TbPrompt | null>(null);
  const [pending, setPending] = useState<"discard" | { open: TbPrompt | null } | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await tbPromptList());
      setFailure("");
    } catch (error) {
      setFailure(String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { tags: allTags, counts: tagCounts } = useMemo(() => collectTags(items), [items]);

  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          matchTags(item.tags, activeTags, tagMode) &&
          matchQuery(query, [item.title, item.description, item.content, item.tags]),
      ),
    [items, query, activeTags, tagMode],
  );

  /** 保存只落盘 / 发布才记版本：所以「脏」要分两根轴判断 */
  const dirtyVsSaved = useMemo(() => {
    if (!draft) return false;
    if (!saved) return Boolean(draft.title.trim() || draft.content.trim());
    return JSON.stringify(draft) !== JSON.stringify(saved);
  }, [draft, saved]);

  const lastPublished = useMemo<TbVersion | null>(() => {
    const versions = saved?.versions ?? [];
    return versions.length ? versions.reduce((a, b) => (b.v > a.v ? b : a)) : null;
  }, [saved]);

  const dirtyVsPublished = useMemo(() => {
    if (!draft?.content.trim()) return false;
    if (!lastPublished) return true;
    return draft.content !== lastPublished.content;
  }, [draft, lastPublished]);

  const canSave = Boolean(draft?.title.trim() && draft?.content.trim());

  const statusText = !lastPublished
    ? t("toolbox.prompts.statusNever")
    : dirtyVsPublished
      ? t("toolbox.prompts.statusDirty", { v: lastPublished.v })
      : t("toolbox.prompts.statusClean", { v: lastPublished.v });

  function edit(patch: Partial<TbPrompt>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function openEditor(next: TbPrompt | null) {
    if (dirtyVsSaved && draft?.id !== next?.id) {
      setPending({ open: next });
      return;
    }
    const base = next && next.id ? next : null;
    setSaved(base);
    setDraft(next ? { ...next } : blank());
    setContentMode("edit");
  }

  async function save(publish: boolean) {
    if (!draft || !canSave || busy) return;
    setBusy(true);
    try {
      const before = (saved?.versions ?? []).length;
      // 整份 spread 出去：磁盘上的未知字段（源侧的 variables 等）原样带回去，
      // 只挑已知字段重新组装会把它们抹掉。
      const stored = await tbPromptSave(
        { ...draft, title: draft.title.trim(), description: draft.description.trim() },
        publish,
      );
      setSaved(stored);
      setDraft({ ...stored });
      await load();
      if (!publish) toast.success(t("toolbox.prompts.stashed"));
      else if (stored.versions.length > before) toast.success(t("toolbox.prompts.published"));
      else toast.info(t("toolbox.prompts.publishNoChange"));
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const target = deleting;
    setDeleting(null);
    if (!target) return;
    try {
      if (target.id) await tbPromptDelete(target.id);
      if (draft?.id === target.id) {
        setSaved(null);
        setDraft(null);
      }
      await load();
      toast.success(t("toolbox.prompts.deleted"));
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function restore(version: TbVersion) {
    if (!draft?.id) return;
    try {
      const next = await tbPromptRestore(draft.id, version.v);
      setSaved(next);
      setDraft({ ...next });
      await load();
      toast.success(t("toolbox.restored", { v: version.v }));
    } catch (error) {
      toast.error(String(error));
    }
  }

  return (
    <ToolboxPage
      section="prompts"
      actions={
        <>
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5">
            {(
              [
                { id: "grid", icon: LayoutGrid, key: "toolbox.prompts.viewGrid" },
                { id: "list", icon: Rows3, key: "toolbox.prompts.viewList" },
              ] as const
            ).map(({ id, icon: Icon, key }) => (
              <button
                key={id}
                type="button"
                title={t(key)}
                aria-label={t(key)}
                onClick={() => setView(id)}
                className={cn(
                  "grid size-7 place-items-center rounded-md outline-none transition-colors",
                  view === id ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
              </button>
            ))}
          </div>
          <SearchBar value={query} onChange={setQuery} placeholder={t("toolbox.prompts.searchPlaceholder")} className="w-56" />
          <Button size="sm" onClick={() => openEditor(null)}>
            <Plus className="size-3.5" />
            {t("toolbox.prompts.new")}
          </Button>
        </>
      }
    >
      <FilterBar>
        <TagFilter
          allTags={allTags}
          selected={activeTags}
          onChange={setActiveTags}
          mode={tagMode}
          onModeChange={setTagMode}
          searchable
          counts={tagCounts}
          hideWhenEmpty={false}
          className="mb-0"
        />
      </FilterBar>

      {failure ? <div className="toolbox-error">{failure}</div> : null}

      {loading ? (
        <div className="toolbox-empty">{t("toolbox.loading")}</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={items.length === 0 ? t("toolbox.prompts.empty") : t("toolbox.noMatch")}
          hint={items.length === 0 ? t("toolbox.prompts.emptyHint") : undefined}
          action={
            items.length === 0 ? (
              <Button size="sm" variant="secondary" onClick={() => openEditor(null)}>
                <Plus className="size-3.5" />
                {t("toolbox.prompts.new")}
              </Button>
            ) : undefined
          }
        />
      ) : view === "grid" ? (
        <div className="grid gap-3 pb-2 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((item) => (
            <div
              key={item.id}
              data-anim
              onClick={() => openEditor(item)}
              className="group flex cursor-pointer flex-col rounded-xl border border-border bg-card p-4 shadow-sm outline-none transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                  {item.title || t("toolbox.prompts.untitled")}
                </h3>
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    title={t("toolbox.prompts.copyContent")}
                    aria-label={t("toolbox.prompts.copyContent")}
                    onClick={(event) => {
                      event.stopPropagation();
                      void copyText(item.content).then((ok) => ok && toast.success(t("toolbox.copy")));
                    }}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 hover:text-destructive"
                    title={t("toolbox.delete")}
                    aria-label={t("toolbox.delete")}
                    onClick={(event) => {
                      event.stopPropagation();
                      setDeleting(item);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
              <p className={cn("mt-1.5 line-clamp-2 text-xs leading-relaxed", item.description ? "text-ink-2" : "text-ink-3")}>
                {item.description || item.content.slice(0, 120)}
              </p>
              <div className="mt-3 flex flex-wrap gap-1">
                {item.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
              <div className="mt-auto flex items-center gap-2 pt-3 text-[11px] text-ink-3">
                <span>
                  {t("toolbox.updatedAt")} {timeLabel(item.updatedAt, i18n.language)}
                </span>
                {item.versions.length > 0 ? (
                  <span className="ml-auto inline-flex items-center gap-1">
                    <History className="size-3" />v{item.versions[item.versions.length - 1].v}
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="toolbox-list pb-2">
          {filtered.map((item) => (
            <button key={item.id} type="button" className="toolbox-row" onClick={() => openEditor(item)}>
              <span className="toolbox-row-head">
                <strong>{item.title || t("toolbox.prompts.untitled")}</strong>
                {item.versions.length > 0 ? <span className="toolbox-badge">v{item.versions[item.versions.length - 1].v}</span> : null}
              </span>
              {item.description ? <p>{item.description}</p> : null}
              <span className="toolbox-row-meta">
                <span>{t("toolbox.prompts.versionCount", { count: item.versions.length })}</span>
                <span>·</span>
                <span>{timeLabel(item.updatedAt, i18n.language)}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open) {
            if (!dirtyVsSaved) {
              setDraft(null);
              setSaved(null);
              return;
            }
            setPending("discard");
          }
        }}
      >
        <DialogContent className="flex h-[92vh] max-h-[92vh] flex-col gap-3 sm:max-w-[1100px]">
          <DialogHeader>
            <DialogTitle>{saved ? t("toolbox.prompts.editTitle") : t("toolbox.prompts.newTitle")}</DialogTitle>
          </DialogHeader>

          <DialogBody className="flex flex-1 flex-col gap-3">
            <div className="grid shrink-0 gap-3 sm:grid-cols-2">
              <Field label={t("toolbox.prompts.title")}>
                <Input
                  value={draft?.title ?? ""}
                  onChange={(event) => edit({ title: event.target.value })}
                  placeholder={t("toolbox.prompts.titlePlaceholder")}
                  autoFocus
                />
              </Field>
              <Field label={t("toolbox.tags.title")} hint={t("toolbox.tags.placeholder")}>
                <TagInput value={draft?.tags ?? []} onChange={(tags) => edit({ tags })} />
              </Field>
            </div>
            <Field label={t("toolbox.prompts.description")} className="shrink-0">
              <Input
                value={draft?.description ?? ""}
                onChange={(event) => edit({ description: event.target.value })}
                placeholder={t("toolbox.prompts.descriptionPlaceholder")}
              />
            </Field>

            {/* 主体：左正文（占满剩余高度） / 右侧栏（版本时间轴，独立滚动）。
                窗口窄到放不下两栏时，侧栏整块换到正文下方，而不是把两边都挤成一列字。 */}
            <div className="flex min-h-0 flex-1 flex-wrap gap-3">
              <div className="flex min-h-0 min-w-[280px] flex-1 flex-col gap-1.5">
                <div className="flex flex-wrap shrink-0 items-center gap-2">
                  <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5">
                    {CONTENT_MODES.map(({ id, icon: Icon, key }) => (
                      <button
                        key={id}
                        type="button"
                        title={t(key)}
                        onClick={() => setContentMode(id)}
                        className={cn(
                          "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium outline-none transition-colors",
                          contentMode === id ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
                        )}
                      >
                        <Icon className="size-3.5" />
                        <span className="hidden lg:inline">{t(key)}</span>
                      </button>
                    ))}
                  </div>

                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    {/* 暂存：只落盘，不产生版本记录 */}
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 px-2.5 text-[11px]"
                      disabled={busy || !canSave || !dirtyVsSaved}
                      onClick={() => void save(false)}
                    >
                      <Archive className="size-3.5" />
                      {t("toolbox.prompts.stash")}
                    </Button>
                    {/* 发布：正文相对已发布版本有变动才允许 */}
                    <Button
                      size="sm"
                      className="h-7 px-2.5 text-[11px]"
                      disabled={busy || !canSave || !dirtyVsPublished}
                      onClick={() => void save(true)}
                    >
                      <CloudUpload className="size-3.5" />
                      {t("toolbox.prompts.publish")}
                    </Button>
                  </div>
                </div>

                <div className="min-h-0 flex-1">
                  {contentMode === "preview" ? (
                    <div className="h-full overflow-y-auto rounded-lg border border-border bg-bg-subtle p-3">
                      <MarkdownView source={draft?.content ?? ""} />
                    </div>
                  ) : contentMode === "split" ? (
                    <div className="grid h-full grid-cols-2 gap-3">
                      <Textarea
                        value={draft?.content ?? ""}
                        onChange={(event) => edit({ content: event.target.value })}
                        placeholder={t("toolbox.prompts.contentPlaceholder")}
                        className="h-full min-h-0 resize-none font-mono text-[13px]"
                        spellCheck={false}
                      />
                      <div className="min-h-0 overflow-y-auto rounded-lg border border-border bg-bg-subtle p-3">
                        <MarkdownView source={draft?.content ?? ""} />
                      </div>
                    </div>
                  ) : (
                    <Textarea
                      value={draft?.content ?? ""}
                      onChange={(event) => edit({ content: event.target.value })}
                      placeholder={t("toolbox.prompts.contentPlaceholder")}
                      className="h-full min-h-0 resize-none font-mono text-[13px]"
                      spellCheck={false}
                    />
                  )}
                </div>
              </div>

              <aside className="flex w-[340px] min-w-[280px] shrink-0 flex-col gap-2">
                <VersionList fill versions={saved?.versions ?? []} current={draft?.content ?? ""} onRestore={(version) => void restore(version)} />
              </aside>
            </div>
          </DialogBody>

          <DialogFooter className="flex-wrap justify-between">
            <span className="text-[11px] text-ink-3">{statusText}</span>
            <Button
              size="sm"
              variant="secondary"
              className="w-fit"
              onClick={() =>
                dirtyVsSaved
                  ? setPending("discard")
                  : (() => {
                      setDraft(null);
                      setSaved(null);
                    })()
              }
            >
              {t("toolbox.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        title={t("toolbox.prompts.deleteTitle", { name: deleting?.title || t("toolbox.prompts.untitled") })}
        body={t("toolbox.prompts.deleteBody")}
        confirmLabel={t("toolbox.delete")}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => void remove()}
      />

      <ConfirmDialog
        open={pending !== null}
        title={t("toolbox.discardTitle")}
        body={t("toolbox.prompts.discardMsg")}
        confirmLabel={t("toolbox.discard")}
        danger
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending === "discard") {
            setPending(null);
            setDraft(null);
            setSaved(null);
            return;
          }
          const next = pending && typeof pending === "object" ? pending.open : null;
          setPending(null);
          setSaved(next && next.id ? next : null);
          setDraft(next ? { ...next } : blank());
          setContentMode("edit");
        }}
      />
    </ToolboxPage>
  );
}
