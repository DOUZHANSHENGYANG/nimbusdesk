import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FolderOpen, History, Plus, RefreshCw, Search, Sparkles, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { pickFolder } from "@/lib/tauri";
import { tbSkillCreate, tbSkillDelete, tbSkillImport, tbSkillList, tbSkillRead, tbSkillRestore, tbSkillReveal, tbSkillSave, type TbSkillDoc, type TbSkillMeta } from "./api";
import { ConfirmDialog } from "./confirm";
import { filterItems, sizeLabel, timeLabel } from "./core";
import { TagEditor } from "./tag-input";
import "./toolbox.css";

type Pending = { kind: "delete" } | { kind: "switch"; dirName: string } | null;

export function SkillsView() {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<TbSkillMeta[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  const [doc, setDoc] = useState<TbSkillDoc | null>(null);
  const [frontmatter, setFrontmatter] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [pending, setPending] = useState<Pending>(null);

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

  useEffect(() => { void load(); }, [load]);

  const open = useCallback(async (dirName: string) => {
    try {
      const next = await tbSkillRead(dirName);
      setDoc(next);
      setFrontmatter(next.frontmatter);
      setBody(next.body);
      setTags(next.meta.tags);
      setFailure("");
    } catch (error) {
      toast.error(String(error));
    }
  }, []);

  const dirty = Boolean(doc) && (frontmatter !== doc!.frontmatter || body !== doc!.body || tags.join("\u0000") !== doc!.meta.tags.join("\u0000"));
  const visible = useMemo(() => filterItems(items, query), [items, query]);

  function select(dirName: string) {
    if (dirName === doc?.meta.dirName) return;
    if (dirty) { setPending({ kind: "switch", dirName }); return; }
    void open(dirName);
  }

  async function save(publish: boolean) {
    if (!doc) return;
    setBusy(true);
    try {
      const meta = await tbSkillSave({ dirName: doc.meta.dirName, frontmatter, body, tags, publish, note: "" });
      await open(meta.dirName);
      await load();
      toast.success(publish ? t("toolbox.skills.published") : t("toolbox.saved"));
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
    if (!doc) return;
    setPending(null);
    try {
      await tbSkillDelete(doc.meta.dirName);
      setDoc(null);
      setFrontmatter("");
      setBody("");
      setTags([]);
      await load();
      toast.success(t("toolbox.skills.deleted"));
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function restore(version: number) {
    if (!doc) return;
    try {
      const next = await tbSkillRestore(doc.meta.dirName, version);
      setDoc(next);
      setFrontmatter(next.frontmatter);
      setBody(next.body);
      setTags(next.meta.tags);
      await load();
      toast.success(t("toolbox.restored", { v: version }));
    } catch (error) {
      toast.error(String(error));
    }
  }

  return (
    <>
      <div className="toolbox-split">
        <div className="toolbox-column">
          <div className="toolbox-toolbar">
            <label className="toolbox-search">
              <Search />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("toolbox.searchSkills")} aria-label={t("toolbox.searchSkills")} />
            </label>
            <button type="button" className="toolbox-icon-button" title={t("toolbox.refresh")} aria-label={t("toolbox.refresh")} onClick={() => void load()}>
              <RefreshCw />
            </button>
          </div>
          <div className="toolbox-actions" style={{ marginBottom: 10 }}>
            <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" />
              {t("toolbox.skills.new")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void importSkill()}>
              <Upload className="size-3.5" />
              {t("toolbox.skills.import")}
            </Button>
          </div>
          <div className="toolbox-column toolbox-column-panel">
            {loading ? (
              <div className="toolbox-empty">{t("toolbox.loading")}</div>
            ) : visible.length === 0 ? (
              <div className="toolbox-empty">
                <Sparkles />
                <span>{items.length === 0 ? t("toolbox.skills.empty") : t("toolbox.noMatch")}</span>
              </div>
            ) : (
              <div className="toolbox-list">
                {visible.map((item) => (
                  <button
                    key={item.dirName}
                    type="button"
                    className="toolbox-row"
                    aria-current={doc?.meta.dirName === item.dirName}
                    onClick={() => select(item.dirName)}
                  >
                    <span className="toolbox-row-head">
                      <strong>{item.name}</strong>
                    </span>
                    {item.description && <p>{item.description}</p>}
                    <span className="toolbox-row-meta">
                      <span>{sizeLabel(item.bytes)}</span>
                      <span>·</span>
                      <span>{timeLabel(item.updatedAt, i18n.language)}</span>
                    </span>
                    {item.tags.length > 0 && (
                      <span className="toolbox-tags">
                        {item.tags.map((tag) => (
                          <span className="toolbox-tag" key={tag}>{tag}</span>
                        ))}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="toolbox-column toolbox-detail">
          {failure && <div className="toolbox-error">{failure}</div>}
          {!doc ? (
            <div className="toolbox-empty">
              <FolderOpen />
              <span>{t("toolbox.skills.pick")}</span>
            </div>
          ) : (
            <>
              <div className="toolbox-detail-head">
                <div>
                  <h2>{doc.meta.name}</h2>
                  <code>{doc.path}</code>
                </div>
                <div className="toolbox-actions">
                  <button type="button" className="toolbox-icon-button" title={t("toolbox.reveal")} aria-label={t("toolbox.reveal")} onClick={() => void tbSkillReveal(doc.meta.dirName).catch((error) => toast.error(String(error)))}>
                    <FolderOpen />
                  </button>
                  <button type="button" className="toolbox-icon-button toolbox-danger" title={t("toolbox.delete")} aria-label={t("toolbox.delete")} onClick={() => setPending({ kind: "delete" })}>
                    <Trash2 />
                  </button>
                </div>
              </div>

              <div className="toolbox-field">
                <label>{t("toolbox.tags.title")}</label>
                <TagEditor value={tags} onChange={setTags} />
              </div>

              <div className="toolbox-field">
                <label htmlFor="tb-skill-frontmatter">
                  {t("toolbox.skills.frontmatter")}
                  <em>{t("toolbox.skills.frontmatterHint")}</em>
                </label>
                <Textarea id="tb-skill-frontmatter" className="mono" rows={5} spellCheck={false} value={frontmatter} onChange={(event) => setFrontmatter(event.target.value)} />
              </div>

              <div className="toolbox-field" style={{ flex: 1, minHeight: 0 }}>
                <label htmlFor="tb-skill-body">{t("toolbox.skills.body")}</label>
                <Textarea id="tb-skill-body" className="mono grow" spellCheck={false} value={body} onChange={(event) => setBody(event.target.value)} />
              </div>

              <div className="toolbox-actions">
                <Button size="sm" disabled={busy || !dirty} onClick={() => void save(false)}>
                  {t("toolbox.save")}
                </Button>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void save(true)}>
                  {t("toolbox.skills.publish")}
                </Button>
                <span className="spacer" />
                <span className="toolbox-hint">{dirty ? t("toolbox.unsaved") : t("toolbox.savedState")}</span>
              </div>

              <div className="toolbox-field">
                <label>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <History className="size-3.5" />
                    {t("toolbox.versions")}
                  </span>
                  <em>{t("toolbox.versionsHint", { count: doc.versionList.length })}</em>
                </label>
                {doc.versionList.length === 0 ? (
                  <span className="toolbox-hint">{t("toolbox.versionsEmpty")}</span>
                ) : (
                  <div className="toolbox-versions">
                    {[...doc.versionList].reverse().map((version) => (
                      <div className="toolbox-version" key={version.v}>
                        <strong>v{version.v}</strong>
                        <time>{timeLabel(version.savedAt, i18n.language)}</time>
                        {version.note && <span>{version.note}</span>}
                        <button type="button" onClick={() => void restore(version.v)}>{t("toolbox.restore")}</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t("toolbox.skills.new")}</DialogTitle>
            <DialogDescription>{t("toolbox.skills.newHint")}</DialogDescription>
          </DialogHeader>
          <div className="toolbox-field">
            <label htmlFor="tb-new-name">{t("toolbox.skills.name")}</label>
            <Input id="tb-new-name" autoFocus value={newName} placeholder={t("toolbox.skills.namePlaceholder")} onChange={(event) => setNewName(event.target.value)} />
          </div>
          <div className="toolbox-field">
            <label htmlFor="tb-new-desc">{t("toolbox.skills.description")}</label>
            <Textarea id="tb-new-desc" rows={3} value={newDescription} placeholder={t("toolbox.skills.descriptionPlaceholder")} onChange={(event) => setNewDescription(event.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={() => setCreating(false)}>{t("toolbox.cancel")}</Button>
            <Button size="sm" disabled={busy || !newName.trim()} onClick={() => void create()}>{t("toolbox.create")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === "delete" ? t("toolbox.skills.deleteTitle", { name: doc?.meta.name ?? "" }) : t("toolbox.discardTitle")}
        body={pending?.kind === "delete" ? t("toolbox.skills.deleteBody") : t("toolbox.discardBody")}
        confirmLabel={pending?.kind === "delete" ? t("toolbox.delete") : t("toolbox.discard")}
        danger={pending?.kind === "delete"}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending?.kind === "delete") { void remove(); return; }
          const target = pending?.kind === "switch" ? pending.dirName : null;
          setPending(null);
          if (target) void open(target);
        }}
      />
    </>
  );
}
