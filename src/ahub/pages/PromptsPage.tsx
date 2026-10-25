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
  Wand2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/ahub/components/ConfirmDialog";
import { EmptyState } from "@/ahub/components/EmptyState";
import { matchTags, type TagMode } from "@/ahub/components/TagFilter";
import { TagShelf } from "@/ahub/components/TagShelf";
import { TagManagerView } from "@/ahub/components/TagManagerView";
import { TagCommand } from "@/ahub/components/TagCommand";
import { SearchBar } from "@/ahub/components/SearchBar";
import { PageShell } from "@/ahub/components/PageShell";
import { PromptFillDialog, PromptVarsPanel } from "@/ahub/components/PromptVars";
import { TagInput } from "@/ahub/components/TagInput";
import { Markdown } from "@/ahub/components/Markdown";
import { VersionList } from "@/ahub/components/VersionList";
import { Badge } from "@/ahub/components/ui/badge";
import { Button } from "@/ahub/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ahub/components/ui/dialog";
import { Field, Input, Textarea } from "@/ahub/components/ui/input";
import { copyText } from "@/ahub/lib/api";
import type { Prompt, PromptVariable } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";
import { useData } from "@/ahub/stores/data";

function fmt(iso: string): string {
  try {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  } catch {
    return iso;
  }
}

/** 正文区的三种呈现方式：纯编辑 / 纯预览 / 左右分栏对照 */
type ContentMode = "edit" | "preview" | "split";

const CONTENT_MODES: { id: ContentMode; icon: typeof Eye; key: string }[] = [
  { id: "edit", icon: PencilLine, key: "prompts.modeEdit" },
  { id: "preview", icon: Eye, key: "prompts.modePreview" },
  { id: "split", icon: Columns2, key: "prompts.modeSplit" },
];

/** 正文里是否有占位符 —— 只做轻量判定，真正解析交给后端 */
function hasVars(p: Prompt): boolean {
  // 用 indexOf 而非正则：避免多层转义出错，语义同样清楚
  const open = p.content.indexOf('{{');
  if (open < 0) return false;
  const close = p.content.indexOf('}}', open + 2);
  if (close < 0) return false;
  const name = p.content.slice(open + 2, close).trim();
  return name.length > 0 && !name.includes('{');
}

export function PromptsPage() {
  const { t } = useTranslation();
  const prompts = useData((s) => s.prompts);
  const savePrompt = useData((s) => s.savePrompt);
  const deletePrompt = useData((s) => s.deletePrompt);

  const [query, setQuery] = useState("");
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [pageTab, setPageTab] = useState<"list" | "tags">("list");
  const [tagCommandOpen, setTagCommandOpen] = useState(false);
  const [tagMode, setTagMode] = useState<TagMode>("or");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Prompt | null>(null);
  const [deleting, setDeleting] = useState<Prompt | null>(null);

  // editor draft
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [variables, setVariables] = useState<PromptVariable[]>([]);
  /** 正在填充的提示词（非 null 时弹框打开） */
  const [filling, setFilling] = useState<Prompt | null>(null);
  /** 正文区呈现方式 */
  const [contentMode, setContentMode] = useState<ContentMode>("edit");
  /** 暂存/发布进行中 —— 防止连点产生两条版本 */
  const [busy, setBusy] = useState(false);
  /** 有未暂存改动时，关闭前先确认 */
  const [discardOpen, setDiscardOpen] = useState(false);

  /** 标签 → 数量（与 MCP / Skills 同一套语义） */
  const tagCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of prompts) for (const tg of p.tags) m[tg] = (m[tg] ?? 0) + 1;
    return m;
  }, [prompts]);

  const allTags = useMemo(() => {
    const keys = new Set<string>(Object.keys(tagCounts));
    // 已选标签始终保留，避免筛选后无法取消
    activeTags.forEach((k) => keys.add(k));
    return [...keys].sort((a, b) => (tagCounts[b] ?? 0) - (tagCounts[a] ?? 0) || a.localeCompare(b));
  }, [tagCounts, activeTags]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return prompts.filter((p) => {
      if (!matchTags(p.tags, activeTags, tagMode)) return false;
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.content.toLowerCase().includes(q) ||
        p.tags.some((tg) => tg.toLowerCase().includes(q))
      );
    });
  }, [prompts, query, activeTags, tagMode]);

  const [view, setView] = useState<"grid" | "preview">("grid");
  const [paneMode, setPaneMode] = useState<"preview" | "edit">("preview");
  const [editContent, setEditContent] = useState("");
  const [tagsEditing, setTagsEditing] = useState(false);
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = filtered.find((p) => p.id === activeId) ?? filtered[0] ?? null;

  const openNew = () => {
    setEditing(null);
    setTitle("");
    setDescription("");
    setContent("");
    setTags([]);
    setVariables([]);
    setContentMode("edit");
    setEditorOpen(true);
  };

  useEffect(() => {
    setTagsEditing(false);
  }, [activeId]);

  const openEdit = (p: Prompt) => {
    setEditing(p);
    setTitle(p.title);
    setDescription(p.description);
    setContent(p.content);
    setTags(p.tags);
    setVariables(p.variables ?? []);
    setContentMode("edit");
    setEditorOpen(true);
  };

  /** 最近一次发布的版本 —— 时间轴里的节点才是"已发布"，暂存不算 */
  const lastPublished = useMemo(() => {
    const vs = editing?.versions ?? [];
    return vs.length ? vs.reduce((a, b) => (b.v > a.v ? b : a)) : null;
  }, [editing]);

  const canSave = Boolean(title.trim() && content.trim());

  /** 相对「已发布内容」是否有变动 —— 发布按钮的唯一开关。
   *  从未发布过时没有基线可比，允许把当前正文发布成第一个版本。 */
  const dirtyVsPublished = useMemo(() => {
    if (!content.trim()) return false;
    if (!lastPublished) return true;
    return content !== lastPublished.content;
  }, [content, lastPublished]);

  /** 相对「磁盘上的内容」是否有变动 —— 暂存按钮的开关，避免点了没反应 */
  const dirtyVsSaved = useMemo(() => {
    if (!editing) return Boolean(title.trim() || content.trim());
    return (
      title !== editing.title ||
      description !== editing.description ||
      content !== editing.content ||
      tags.join("\u0001") !== editing.tags.join("\u0001") ||
      JSON.stringify(variables) !== JSON.stringify(editing.variables ?? [])
    );
  }, [editing, title, description, content, tags, variables]);

  const statusText = !lastPublished
    ? t("prompts.statusNever")
    : dirtyVsPublished
      ? t("prompts.statusDirty", { v: lastPublished.v })
      : t("prompts.statusClean", { v: lastPublished.v });

  /**
   * 保存。`publish` 决定是否额外记一条版本：
   *   · false —— 暂存：只落盘，时间轴不动
   *   · true  —— 发布：落盘 + 把当前正文记为一条新版本
   * 保存后把返回结果写回 `editing`，这样时间轴能立刻出现新节点。
   */
  const doSave = async (publish: boolean) => {
    if (!canSave || busy) return;
    setBusy(true);
    try {
      const saved = await savePrompt(
        {
          id: editing?.id ?? "",
          title: title.trim(),
          description: description.trim(),
          content,
          tags,
          variables,
          versions: editing?.versions ?? [],
          createdAt: editing?.createdAt ?? "",
          updatedAt: editing?.updatedAt ?? "",
        },
        publish,
      );
      const before = (editing?.versions ?? []).length;
      setEditing(saved);
      if (publish) {
        if (saved.versions.length > before) {
          const v = Math.max(...saved.versions.map((x) => x.v));
          toast.success(t("prompts.published", { v }));
        } else {
          // 后端对"与最后一条版本内容相同"做了去重，这里如实告知
          toast.info(t("prompts.publishNoChange"));
        }
      } else {
        toast.success(t("prompts.stashed"));
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };


  return (
    <PageShell
      title={t("nav.prompts")}
      actions={
        <>
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5">
            <button
              type="button"
              title={t("prompts.viewGrid")}
              onClick={() => setView("grid")}
              className={cn(
                "grid size-7 place-items-center rounded-md outline-none transition-colors",
                view === "grid" ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
              )}
            >
              <LayoutGrid className="size-4" />
            </button>
            <button
              type="button"
              title={t("prompts.viewPreview")}
              onClick={() => setView("preview")}
              className={cn(
                "grid size-7 place-items-center rounded-md outline-none transition-colors",
                view === "preview" ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
              )}
            >
              <Rows3 className="size-4" />
            </button>
          </div>
          <SearchBar value={query} onChange={setQuery} placeholder={t("prompts.searchPlaceholder")} className="w-56" />
          <Button onClick={openNew}>
            <Plus />
            {t("prompts.newPrompt")}
          </Button>
        </>
      }
    >
      <div className="mb-3 flex w-fit items-center gap-1 rounded-lg border border-border bg-surface p-0.5">
        {([
          { id: "list" as const, label: t("nav.prompts") },
          { id: "tags" as const, label: t("tagShelf.title") },
        ]).map((item) => (
          <button key={item.id} type="button" aria-pressed={pageTab === item.id} onClick={() => setPageTab(item.id)}
            className={cn("flex h-7 items-center rounded-md px-2.5 text-[11.5px] font-medium",
              pageTab === item.id ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground")}>
            {item.label}
          </button>
        ))}
      </div>

      {pageTab === "tags" ? (
        <TagManagerView allTags={allTags} counts={tagCounts} resultCount={filtered.length} />
      ) : (
        <>
      <TagShelf
        allTags={allTags}
        selected={activeTags}
        onChange={setActiveTags}
        mode={tagMode}
        onModeChange={setTagMode}
        counts={tagCounts}
        hideWhenEmpty={false}
        onManage={() => setPageTab("tags")}
        onCommand={() => setTagCommandOpen(true)}
      />

      {filtered.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={t("common.empty")}
          hint={t("prompts.emptyHint")}
          action={
            <Button onClick={openNew} variant="secondary">
              <Plus />
              {t("prompts.newPrompt")}
            </Button>
          }
        />
      ) : view === "preview" ? (
        <div className="flex h-[calc(100vh-190px)] min-h-96 gap-4">
          <aside className="flex w-56 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {filtered.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setActiveId(p.id)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left outline-none transition-colors",
                    active?.id === p.id ? "bg-primary-soft" : "hover:bg-surface-2",
                  )}
                >
                  <span className={cn("truncate text-[13px] font-medium", active?.id === p.id ? "text-primary" : "text-foreground")}>
                    {p.title}
                  </span>
                  <span className="flex items-center gap-1 text-[10px] text-ink-3">
                    {p.tags.slice(0, 2).map((tg) => (
                      <span key={tg} className="rounded bg-surface-2 px-1">
                        {tg}
                      </span>
                    ))}
                    <span className="ml-auto">{fmt(p.updatedAt)}</span>
                  </span>
                </button>
              ))}
            </div>
          </aside>
          <div className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card p-5">
            {active ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <h2 className="min-w-0 text-base font-semibold text-foreground">{active.title}</h2>
                  <div className="flex shrink-0 items-center gap-2">
                    {/* 预览 / 编辑 切换 */}
                    <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5">
                      <button
                        type="button"
                        onClick={() => {
                          setPaneMode("preview");
                          setEditContent(active.content);
                        }}
                        className={cn(
                          "rounded-md px-2.5 py-1 text-[11px] font-medium outline-none transition-colors",
                        )}
                      >
                        {t("prompts.tabPreview")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditContent(active.content);
                          setPaneMode("edit");
                        }}
                        className={cn(
                          "rounded-md px-2.5 py-1 text-[11px] font-medium outline-none transition-colors",
                          paneMode === "edit" ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
                        )}
                      >
                        {t("prompts.tabEdit")}
                      </button>
                    </div>
                    {paneMode === "preview" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void copyText(active.content).then((ok) => ok && toast.success(t("common.copied")))}
                      >
                        <Copy />
                        {t("common.copy")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={editContent === active.content}
                        onClick={() =>
                          void savePrompt({ ...active, content: editContent }).then(() => {
                            toast.success(t("prompts.saved"));
                            setPaneMode("preview");
                          })
                        }
                      >
                        {t("common.save")}
                      </Button>
                    )}
                  </div>
                </div>
                {active.description ? <p className="mt-1 text-xs text-ink-2">{active.description}</p> : null}
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {tagsEditing ? (
                    <>
                      <TagInput value={draftTags} onChange={setDraftTags} className="min-h-7 max-w-md flex-1" />
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 px-2.5 text-[11px]"
                        onClick={() =>
                          void savePrompt({ ...active, tags: draftTags }).then(() => {
                            toast.success(t("prompts.saved"));
                            setTagsEditing(false);
                          })
                        }
                      >
                        {t("common.save")}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setTagsEditing(false)}>
                        {t("common.cancel")}
                      </Button>
                    </>
                  ) : active.tags.length ? (
                    <>
                      {active.tags.map((tg) => (
                        <Badge key={tg} variant="default">
                          {tg}
                        </Badge>
                      ))}
                      <button
                        type="button"
                        onClick={() => {
                          setDraftTags(active.tags);
                          setTagsEditing(true);
                        }}
                        className="ml-1 text-[11px] text-ink-3 outline-none hover:text-primary"
                      >
                        {t("common.edit")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setDraftTags([]);
                        setTagsEditing(true);
                      }}
                      className="rounded-full border border-dashed border-border px-2.5 py-0.5 text-[11px] text-ink-3 outline-none hover:border-primary/40 hover:text-primary"
                    >
                      {t("prompts.tagsEmpty")}
                    </button>
                  )}
                </div>
                <div className="mt-4 min-h-0 flex-1 border-t border-border pt-4">
                  {paneMode === "preview" ? (
                    <Markdown source={active.content} />
                  ) : (
                    <div className="grid h-[58vh] grid-cols-2 gap-3">
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        className="h-full w-full resize-none rounded-lg border border-input bg-surface p-3 font-mono text-[13px] leading-relaxed text-foreground outline-none transition-[border-color,box-shadow] focus:border-primary focus:shadow-[0_0_0_3px_var(--ah-primary-soft)]"
                        spellCheck={false}
                      />
                      <div className="min-h-0 overflow-y-auto rounded-lg border border-border bg-bg-subtle p-3">
                        <Markdown source={editContent} />
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((p) => (
            <div
              key={p.id}
              data-anim
              onClick={() => openEdit(p)}
              className="group flex cursor-pointer flex-col rounded-xl border border-border bg-card p-4 shadow-sm outline-none transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{p.title}</h3>
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  {/* 只有正文里真有占位符时才出现「填充」，否则这个按钮点进去是空的 */}
                  {hasVars(p) ? (
                    <Button
                      size="iconSm"
                      variant="ghost"
                      title={t("prompts.fillAction")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setFilling(p);
                      }}
                    >
                      <Wand2 />
                    </Button>
                  ) : null}
                  <Button
                    size="iconSm"
                    variant="ghost"
                    title={t("prompts.copyContent")}
                    onClick={(e) => {
                      e.stopPropagation();
                      void copyText(p.content).then((ok) => ok && toast.success(t("common.copied")));
                    }}
                  >
                    <Copy />
                  </Button>
                  <Button
                    size="iconSm"
                    variant="ghost"
                    title={t("common.delete")}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleting(p);
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
              {p.description ? (
                <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-2">{p.description}</p>
              ) : (
                <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-3">{p.content.slice(0, 120)}</p>
              )}
              <div className="mt-3 flex flex-wrap gap-1">
                {p.tags.map((tg) => (
                  <Badge key={tg} variant="default">
                    {tg}
                  </Badge>
                ))}
              </div>
              <div className="mt-auto flex items-center gap-2 pt-3 text-[11px] text-ink-3">
                <span>{t("common.updatedAt")} {fmt(p.updatedAt)}</span>
                {p.versions.length > 0 ? (
                  <span className="ml-auto inline-flex items-center gap-1">
                    <History className="size-3" />v{p.versions[p.versions.length - 1].v}
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* editor */}
      <Dialog
        open={editorOpen}
        onOpenChange={(v) => {
          if (!v && dirtyVsSaved) {
            setDiscardOpen(true);
            return;
          }
          setEditorOpen(v);
        }}
      >
        {/* 编辑器需要同时容纳「正文 + 变量 + 版本」三块，宽度与高度都要给足 */}
        <DialogContent wide className="h-[92vh] max-h-[92vh] sm:max-w-[1100px]">
          <DialogHeader>
            <DialogTitle>{editing ? t("prompts.editTitle") : t("prompts.newTitle")}</DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col">
            <DialogBody className="flex min-h-0 flex-1 flex-col gap-3">
              {/* 元信息：两列并排，避免占掉正文的纵向空间 */}
              <div className="grid shrink-0 gap-3 sm:grid-cols-2">
                <Field label={t("prompts.fieldTitle")}>
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("prompts.titlePlaceholder")} autoFocus />
                </Field>
                <Field label={t("common.tags")} hint={t("common.tagPlaceholder")}>
                  <TagInput value={tags} onChange={setTags} />
                </Field>
              </div>
              <Field label={t("prompts.fieldDescription")} className="shrink-0">
                <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("prompts.descriptionPlaceholder")} />
              </Field>

              {/* 主体：左正文（占满剩余高度） / 右侧栏（变量 + 版本，独立滚动） */}
              <div className="flex min-h-0 flex-1 gap-3">
                <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5">
                  {/* 工具栏：左侧三态切换，右侧暂存 / 发布 */}
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5">
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

                    <div className="ml-auto flex items-center gap-2">
                      {/* 暂存：只落盘，不产生版本记录 */}
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy || !canSave || !dirtyVsSaved}
                        onClick={() => void doSave(false)}
                      >
                        <Archive className="size-3.5" />
                        {t("prompts.stash")}
                      </Button>
                      {/* 发布：正文相对已发布版本有变动才允许 */}
                      <Button size="sm" disabled={busy || !canSave || !dirtyVsPublished} onClick={() => void doSave(true)}>
                        <CloudUpload className="size-3.5" />
                        {t("prompts.publish")}
                      </Button>
                    </div>
                  </div>

                  <div className="min-h-0 flex-1">
                    {contentMode === "preview" ? (
                      <div className="h-full overflow-y-auto rounded-lg border border-border bg-bg-subtle p-3">
                        <Markdown source={content} />
                      </div>
                    ) : contentMode === "split" ? (
                      <div className="grid h-full grid-cols-2 gap-3">
                        <Textarea
                          value={content}
                          onChange={(e) => setContent(e.target.value)}
                          placeholder={t("prompts.contentPlaceholder")}
                          className="h-full min-h-0 resize-none font-mono text-[13px]"
                        />
                        <div className="min-h-0 overflow-y-auto rounded-lg border border-border bg-bg-subtle p-3">
                          <Markdown source={content} />
                        </div>
                      </div>
                    ) : (
                      <Textarea
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder={t("prompts.contentPlaceholder")}
                        className="h-full min-h-0 resize-none font-mono text-[13px]"
                      />
                    )}
                  </div>
                </div>
                <aside className="flex w-[340px] shrink-0 flex-col gap-2">
                  {/* 变量定义：正文里的 {{name}} 是唯一事实来源，这里只做元数据编辑。
                      变量折叠/展开会改变自身高度，所以给它一个上限，超出后自己滚。 */}
                  <div className="flex max-h-[45%] min-h-0 shrink-0 flex-col overflow-y-auto">
                    <PromptVarsPanel
                      content={content}
                      variables={variables}
                      onChangeContent={setContent}
                      onChangeVariables={setVariables}
                    />
                  </div>
                  {/* 版本时间轴：只记已发布的版本（暂存不写）。占满右侧剩余高度，
                      新建提示词时同样显示——否则用户以为这块以后也不会出现。 */}
                  <VersionList
                    fill
                    versions={editing?.versions ?? []}
                    current={content}
                    onRestore={(c) => {
                      setContent(c);
                      toast.info(t("prompts.versionRestored"));
                    }}
                  />
                </aside>
              </div>
            </DialogBody>
            <DialogFooter className="justify-between">
              <span className="text-[11px] text-ink-3">{statusText}</span>
              <Button
                variant="secondary"
                onClick={() => (dirtyVsSaved ? setDiscardOpen(true) : setEditorOpen(false))}
              >
                {t("common.close")}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <PromptFillDialog prompt={filling} open={!!filling} onOpenChange={(v) => !v && setFilling(null)} />

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={t("prompts.discardTitle")}
        message={t("prompts.discardMsg")}
        danger
        onConfirm={() => setEditorOpen(false)}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={t("prompts.deleteConfirmTitle")}
        message={t("prompts.deleteConfirmMsg", { title: deleting?.title ?? "" })}
        danger
        onConfirm={() => {
          if (deleting) void deletePrompt(deleting.id).then(() => toast.success(t("prompts.deleted")));
        }}
      />
      <TagCommand
        open={tagCommandOpen}
        onOpenChange={setTagCommandOpen}
        allTags={allTags}
        counts={tagCounts}
        selected={activeTags}
        onToggle={(tag) => {
          const next = new Set(activeTags);
          if (next.has(tag)) next.delete(tag);
          else next.add(tag);
          setActiveTags(next);
        }}
        resultCount={filtered.length}
      />
        </>
      )}
    </PageShell>
  );
}
