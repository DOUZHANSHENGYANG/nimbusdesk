import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Check, Columns2, Eye, FolderOpen, History, Paperclip, PencilLine, Plus, Sparkles, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { pickFolder } from "@/lib/tauri";
import { tbSkillCreate, tbSkillDelete, tbSkillImport, tbSkillList, tbSkillRead, tbSkillRestore, tbSkillReveal, tbSkillSave, type TbSkillDoc, type TbSkillMeta, type TbVersion } from "./api";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./shared/dialog";
import "./toolbox.css";

/** 正文区的三种呈现方式（与提示词页同一套） */
type ContentMode = "edit" | "preview" | "split";

const CONTENT_MODES: { id: ContentMode; icon: typeof Eye; key: string }[] = [
  { id: "edit", icon: PencilLine, key: "toolbox.modeEdit" },
  { id: "preview", icon: Eye, key: "toolbox.modePreview" },
  { id: "split", icon: Columns2, key: "toolbox.modeSplit" },
];

/** 预览要把 frontmatter 一起渲染出来：整份 SKILL.md 才是这个技能的真身。 */
function compose(frontmatter: string, body: string): string {
  const head = frontmatter.trim();
  return head ? `---\n${head}\n---\n\n${body}` : body;
}

/**
 * 技能页。
 *
 * 与源侧一致的：卡片网格（名字 / 来源角标 / 说明 / 标签 / 版本数 / 更新时间 /
 * 右下角动作），点卡片进详情；详情是「左编辑 + 右版本时间轴」两栏，正文带
 * 「编辑 / 预览 / 对照」三态切换，暂存与发布分开（同提示词页两根轴的判脏）。
 *
 * 与源侧不一致的（后端缺口，都不自己造）：
 * - 没有 协议（SKILL.toml）/ 安全审查（vet）/ AI 摘要 三个页签：云台都不做，
 *   所以详情里没有标签栏 —— 只剩「内容」一个页签时标签栏是空的装饰。
 * - 没有文件树页签：需要「列目录 + 读单个文件」两条只读命令（见交付说明）。
 * - frontmatter 是**原文文本框**而不是源侧的结构化字段：云台刻意不引入 YAML
 *   解析器，用户不写就不动它（源侧把 name/description 拆成字段，保存时会重排 YAML）。
 * - 没有多选批量（源侧的多选是为了打包与批量分发，云台没有打包）。
 */
export function SkillsPage() {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<TbSkillMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");

  const [query, setQuery] = useState("");
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [tagMode, setTagMode] = useState<TagMode>("or");

  const [doc, setDoc] = useState<TbSkillDoc | null>(null);
  const [frontmatter, setFrontmatter] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [contentMode, setContentMode] = useState<ContentMode>("edit");
  const [busy, setBusy] = useState(false);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [deleting, setDeleting] = useState<TbSkillMeta | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await tbSkillList());
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

  const open = useCallback(async (dirName: string) => {
    try {
      const next = await tbSkillRead(dirName);
      setDoc(next);
      setFrontmatter(next.frontmatter);
      setBody(next.body);
      setTags(next.meta.tags);
      setContentMode("edit");
      setFailure("");
    } catch (error) {
      toast.error(String(error));
    }
  }, []);

  const { tags: allTags, counts: tagCounts } = useMemo(() => collectTags(items), [items]);

  const filtered = useMemo(
    () => items.filter((item) => matchTags(item.tags, activeTags, tagMode) && matchQuery(query, [item.name, item.description, item.tags])),
    [items, query, activeTags, tagMode],
  );

  /** 两根轴：相对磁盘、相对已发布版本 */
  const dirty = Boolean(doc) && (frontmatter !== doc!.frontmatter || body !== doc!.body || tags.join("\u0000") !== doc!.meta.tags.join("\u0000"));
  const lastPublished = doc?.versionList.length ? doc.versionList.reduce((a, b) => (b.v > a.v ? b : a)) : null;
  const dirtyVsPublished = Boolean(body.trim()) && (!lastPublished || compose(frontmatter, body) !== lastPublished.content);

  function select(dirName: string) {
    if (dirName === doc?.meta.dirName) return;
    if (dirty) {
      setPendingSwitch(dirName);
      return;
    }
    void open(dirName);
  }

  async function save(publish: boolean) {
    if (!doc) return;
    setBusy(true);
    try {
      const before = doc.versionList.length;
      await tbSkillSave({ dirName: doc.meta.dirName, frontmatter, body, tags, publish, note: "" });
      const next = await tbSkillRead(doc.meta.dirName);
      setDoc(next);
      await load();
      if (!publish) toast.success(t("toolbox.saved"));
      else if (next.versionList.length > before) toast.success(t("toolbox.skills.published"));
      else toast.info(t("toolbox.prompts.publishNoChange"));
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const meta = await tbSkillCreate(newName.trim(), newDescription.trim());
      setCreating(false);
      setNewName("");
      setNewDescription("");
      await load();
      await open(meta.dirName);
      toast.success(t("toolbox.skills.created"));
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function importSkill() {
    try {
      const path = await pickFolder();
      if (!path) return;
      const meta = await tbSkillImport(path);
      await load();
      await open(meta.dirName);
      toast.success(t("toolbox.skills.imported", { name: meta.name }));
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function remove() {
    const target = deleting;
    setDeleting(null);
    if (!target) return;
    try {
      await tbSkillDelete(target.dirName);
      if (doc?.meta.dirName === target.dirName) {
        setDoc(null);
        setFrontmatter("");
        setBody("");
        setTags([]);
      }
      await load();
      toast.success(t("toolbox.skills.deleted"));
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function restore(version: TbVersion) {
    if (!doc) return;
    try {
      const next = await tbSkillRestore(doc.meta.dirName, version.v);
      setDoc(next);
      setFrontmatter(next.frontmatter);
      setBody(next.body);
      setTags(next.meta.tags);
      await load();
      toast.success(t("toolbox.restored", { v: version.v }));
    } catch (error) {
      toast.error(String(error));
    }
  }

  return (
    <ToolboxPage
      section="skills"
      actions={
        <>
          <SearchBar value={query} onChange={setQuery} placeholder={t("toolbox.searchSkills")} className="w-56" />
          <Button size="sm" variant="secondary" className="h-8" onClick={() => void importSkill()}>
            <Upload className="size-3.5" />
            {t("toolbox.skills.import")}
          </Button>
          <Button size="sm" className="h-8" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
            {t("toolbox.skills.new")}
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
          icon={Sparkles}
          title={items.length === 0 ? t("toolbox.skills.empty") : t("toolbox.noMatch")}
          hint={items.length === 0 ? t("toolbox.skills.emptyHint") : undefined}
          action={
            items.length === 0 ? (
              <Button size="sm" variant="secondary" onClick={() => void importSkill()}>
                <Upload className="size-3.5" />
                {t("toolbox.skills.import")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-wrap gap-3">
          <div className="min-w-[300px] flex-1 overflow-y-auto pb-2">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((item) => (
                <div
                  key={item.dirName}
                  data-anim
                  onClick={() => select(item.dirName)}
                  className={cn(
                    "group flex cursor-pointer flex-col rounded-xl border border-border bg-card p-4 shadow-sm outline-none transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md",
                    doc?.meta.dirName === item.dirName && "border-primary/60",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-foreground">{item.name}</h3>
                    <Badge variant="outline" className="shrink-0" title={item.origin?.file}>
                      {item.origin ? `${t("toolbox.skills.origin")}: ${item.origin.harness}` : t("toolbox.skills.originLocal")}
                    </Badge>
                  </div>
                  {item.description ? (
                    <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-2">{item.description}</p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-1">
                    {item.tags.map((tag) => {
                      const on = activeTags.has(tag);
                      return (
                        <button
                          key={tag}
                          type="button"
                          title={t("toolbox.skills.tagDrill")}
                          onClick={(event) => {
                            event.stopPropagation();
                            setActiveTags((prev) => new Set(prev).add(tag));
                          }}
                          className="rounded-full outline-none transition-transform hover:-translate-y-px"
                        >
                          <Badge variant={on ? "default" : "secondary"} className={cn(on && "ring-1 ring-primary/40")}>
                            {tag}
                          </Badge>
                        </button>
                      );
                    })}
                    {item.fileCount > 1 ? (
                      <Badge variant="outline" title={t("toolbox.skills.hasAssets")}>
                        <Paperclip />
                        {item.fileCount - 1}
                      </Badge>
                    ) : null}
                    <Badge variant={item.versions > 0 ? "secondary" : "outline"} title={t("toolbox.skills.versionCount", { count: item.versions })}>
                      <History />
                      {item.versions}
                    </Badge>
                  </div>
                  <div className="mt-auto flex items-center gap-1 border-t border-border/60 pt-2.5">
                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink-3">
                      {t("toolbox.updatedAt")} {timeLabel(item.updatedAt, i18n.language)}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      title={t("toolbox.reveal")}
                      aria-label={t("toolbox.reveal")}
                      onClick={(event) => {
                        event.stopPropagation();
                        void tbSkillReveal(item.dirName).catch((error) => toast.error(String(error)));
                      }}
                    >
                      <FolderOpen className="size-3.5" />
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
              ))}
            </div>
          </div>

          {doc ? (
            <aside className="flex w-[360px] min-w-[300px] shrink-0 flex-col gap-2 border-l border-border pl-3">
              <div className="flex items-start gap-2">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
                  <Sparkles className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-semibold text-foreground">{doc.meta.name}</h2>
                  <code className="block truncate text-[10.5px] text-ink-3" dir="ltr" title={doc.path}>
                    {doc.path}
                  </code>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  title={t("toolbox.reveal")}
                  aria-label={t("toolbox.reveal")}
                  onClick={() => void tbSkillReveal(doc.meta.dirName).catch((error) => toast.error(String(error)))}
                >
                  <FolderOpen className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 hover:text-destructive"
                  title={t("toolbox.delete")}
                  aria-label={t("toolbox.delete")}
                  onClick={() => setDeleting({ ...doc.meta })}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>

              <Field label={t("toolbox.tags.title")}>
                <TagInput value={tags} onChange={setTags} />
              </Field>

              <Field label={t("toolbox.skills.frontmatter")} hint={t("toolbox.skills.frontmatterHint")}>
                <Textarea
                  className="min-h-24 font-mono text-[12px]"
                  spellCheck={false}
                  value={frontmatter}
                  onChange={(event) => setFrontmatter(event.target.value)}
                />
              </Field>

              <div className="flex min-h-0 flex-1 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
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
                      </button>
                    ))}
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 px-2.5 text-[11px]"
                      disabled={busy || !dirty}
                      onClick={() => void save(false)}
                    >
                      {t("toolbox.prompts.stash")}
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 px-2.5 text-[11px]"
                      disabled={busy || !dirtyVsPublished}
                      onClick={() => void save(true)}
                    >
                      {t("toolbox.skills.publish")}
                    </Button>
                  </div>
                </div>

                <div className="min-h-0 flex-1">
                  {contentMode === "preview" ? (
                    <div className="h-full overflow-y-auto rounded-lg border border-border bg-bg-subtle p-3">
                      <MarkdownView source={compose(frontmatter, body)} />
                    </div>
                  ) : contentMode === "split" ? (
                    <div className="grid h-full grid-cols-2 gap-2">
                      <Textarea
                        className="h-full min-h-0 resize-none font-mono text-[12px]"
                        spellCheck={false}
                        value={body}
                        onChange={(event) => setBody(event.target.value)}
                      />
                      <div className="min-h-0 overflow-y-auto rounded-lg border border-border bg-bg-subtle p-3">
                        <MarkdownView source={compose(frontmatter, body)} />
                      </div>
                    </div>
                  ) : (
                    <Textarea
                      className="h-full min-h-0 resize-none font-mono text-[12px]"
                      spellCheck={false}
                      value={body}
                      onChange={(event) => setBody(event.target.value)}
                    />
                  )}
                </div>
                <span className="shrink-0 text-[11px] text-ink-3">
                  {dirty ? t("toolbox.unsaved") : t("toolbox.savedState")}
                </span>
              </div>

              <VersionList
                versions={doc.versionList}
                current={compose(frontmatter, body)}
                onRestore={(version) => void restore(version)}
                className="max-h-[42%] overflow-y-auto"
              />
            </aside>
          ) : (
            <aside className="grid w-[360px] min-w-[300px] shrink-0 place-items-center rounded-xl border border-dashed border-border p-6 text-center">
              <span className="inline-flex items-center gap-2 text-xs text-ink-3">
                <Check className="size-3.5" />
                {t("toolbox.skills.pick")}
              </span>
            </aside>
          )}
        </div>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t("toolbox.skills.new")}</DialogTitle>
            <DialogDescription>{t("toolbox.skills.newHint")}</DialogDescription>
          </DialogHeader>
          <Field label={t("toolbox.skills.name")}>
            <Input
              autoFocus
              value={newName}
              placeholder={t("toolbox.skills.namePlaceholder")}
              onChange={(event) => setNewName(event.target.value)}
            />
          </Field>
          <Field label={t("toolbox.prompts.description")}>
            <Textarea
              rows={3}
              value={newDescription}
              placeholder={t("toolbox.skills.descriptionPlaceholder")}
              onChange={(event) => setNewDescription(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button size="sm" variant="secondary" className="w-fit" onClick={() => setCreating(false)}>
              {t("toolbox.cancel")}
            </Button>
            <Button size="sm" className="w-fit" disabled={busy || !newName.trim()} onClick={() => void create()}>
              {t("toolbox.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        title={t("toolbox.skills.deleteTitle", { name: deleting?.name ?? "" })}
        body={t("toolbox.skills.deleteBody")}
        confirmLabel={t("toolbox.delete")}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => void remove()}
      />

      <ConfirmDialog
        open={pendingSwitch !== null}
        title={t("toolbox.discardTitle")}
        body={t("toolbox.discardBody")}
        confirmLabel={t("toolbox.discard")}
        danger
        onCancel={() => setPendingSwitch(null)}
        onConfirm={() => {
          const target = pendingSwitch;
          setPendingSwitch(null);
          if (target) void open(target);
        }}
      />
    </ToolboxPage>
  );
}
