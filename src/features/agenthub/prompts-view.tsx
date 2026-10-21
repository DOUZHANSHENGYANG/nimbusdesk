import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FileText, History, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { tbPromptDelete, tbPromptList, tbPromptRestore, tbPromptSave, type TbPrompt } from "./api";
import { ConfirmDialog } from "./confirm";
import { matchQuery, timeLabel } from "./core";
import { TagEditor } from "./tag-input";
import "./toolbox.css";

const blank = (): TbPrompt => ({
  id: "",
  title: "",
  description: "",
  content: "",
  tags: [],
  versions: [],
  createdAt: "",
  updatedAt: "",
});

export function PromptsView() {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<TbPrompt[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  const [saved, setSaved] = useState<TbPrompt | null>(null);
  const [draft, setDraft] = useState<TbPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<"delete" | { switch: TbPrompt } | null>(null);

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

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(
    () => items.filter((item) => matchQuery(query, [item.title, item.description, item.tags])),
    [items, query],
  );
  const dirty = Boolean(draft) && JSON.stringify(draft) !== JSON.stringify(saved);

  function select(next: TbPrompt) {
    if (next.id === draft?.id && !dirty) return;
    if (dirty) { setPending({ switch: next }); return; }
    setSaved(next);
    setDraft({ ...next });
  }

  async function save(publish: boolean) {
    if (!draft) return;
    setBusy(true);
    try {
      const stored = await tbPromptSave({ ...draft, title: draft.title.trim() || t("toolbox.prompts.untitled") }, publish);
      setSaved(stored);
      setDraft({ ...stored });
      await load();
      toast.success(publish ? t("toolbox.prompts.published") : t("toolbox.saved"));
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!draft) return;
    setPending(null);
    try {
      if (draft.id) await tbPromptDelete(draft.id);
      setSaved(null);
      setDraft(null);
      await load();
      toast.success(t("toolbox.prompts.deleted"));
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function restore(version: number) {
    if (!draft?.id) return;
    try {
      const next = await tbPromptRestore(draft.id, version);
      setSaved(next);
      setDraft({ ...next });
      await load();
      toast.success(t("toolbox.restored", { v: version }));
    } catch (error) {
      toast.error(String(error));
    }
  }

  function edit(patch: Partial<TbPrompt>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  return (
    <>
      <div className="toolbox-split">
        <div className="toolbox-column">
          <div className="toolbox-toolbar">
            <label className="toolbox-search">
              <Search />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("toolbox.searchPrompts")} aria-label={t("toolbox.searchPrompts")} />
            </label>
            <button type="button" className="toolbox-icon-button" title={t("toolbox.refresh")} aria-label={t("toolbox.refresh")} onClick={() => void load()}>
              <RefreshCw />
            </button>
          </div>
          <div className="toolbox-actions" style={{ marginBottom: 10 }}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => { if (dirty) { setPending({ switch: blank() }); return; } setSaved(null); setDraft(blank()); }}
            >
              <Plus className="size-3.5" />
              {t("toolbox.prompts.new")}
            </Button>
          </div>
          <div className="toolbox-column toolbox-column-panel">
            {loading ? (
              <div className="toolbox-empty">{t("toolbox.loading")}</div>
            ) : items.length === 0 ? (
              <div className="toolbox-empty">
                <FileText />
                <span>{t("toolbox.prompts.empty")}</span>
              </div>
            ) : visible.length === 0 ? (
              <div className="toolbox-empty"><span>{t("toolbox.noMatch")}</span></div>
            ) : (
              <div className="toolbox-list">
                {visible.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="toolbox-row"
                    aria-current={draft?.id === item.id}
                    onClick={() => select(item)}
                  >
                    <span className="toolbox-row-head"><strong>{item.title || t("toolbox.prompts.untitled")}</strong></span>
                    {item.description && <p>{item.description}</p>}
                    <span className="toolbox-row-meta">
                      <span>{t("toolbox.prompts.versionCount", { count: item.versions.length })}</span>
                      <span>·</span>
                      <span>{timeLabel(item.updatedAt, i18n.language)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="toolbox-column toolbox-detail">
          {failure && <div className="toolbox-error">{failure}</div>}
          {!draft ? (
            <div className="toolbox-empty">
              <FileText />
              <span>{t("toolbox.prompts.pick")}</span>
            </div>
          ) : (
            <>
              <div className="toolbox-detail-head">
                <div>
                  <h2>{draft.title || t("toolbox.prompts.untitled")}</h2>
                  <code>{draft.id || t("toolbox.prompts.unsavedItem")}</code>
                </div>
                {draft.id && (
                  <div className="toolbox-actions">
                    <button type="button" className="toolbox-icon-button toolbox-danger" title={t("toolbox.delete")} aria-label={t("toolbox.delete")} onClick={() => setPending("delete")}>
                      <Trash2 />
                    </button>
                  </div>
                )}
              </div>

              <div className="toolbox-grid-2">
                <div className="toolbox-field">
                  <label htmlFor="tb-prompt-title">{t("toolbox.prompts.title")}</label>
                  <Input id="tb-prompt-title" value={draft.title} placeholder={t("toolbox.prompts.titlePlaceholder")} onChange={(event) => edit({ title: event.target.value })} />
                </div>
                <div className="toolbox-field">
                  <label htmlFor="tb-prompt-desc">{t("toolbox.prompts.description")}</label>
                  <Input id="tb-prompt-desc" value={draft.description} placeholder={t("toolbox.prompts.descriptionPlaceholder")} onChange={(event) => edit({ description: event.target.value })} />
                </div>
              </div>

              <div className="toolbox-field">
                <label>{t("toolbox.tags.title")}</label>
                <TagEditor value={draft.tags} onChange={(tags) => edit({ tags })} />
              </div>

              <div className="toolbox-field" style={{ flex: 1, minHeight: 0 }}>
                <label htmlFor="tb-prompt-content">{t("toolbox.prompts.content")}</label>
                <Textarea id="tb-prompt-content" className="mono grow" spellCheck={false} value={draft.content} placeholder={t("toolbox.prompts.contentPlaceholder")} onChange={(event) => edit({ content: event.target.value })} />
              </div>

              <div className="toolbox-actions">
                <Button size="sm" disabled={busy || !dirty} onClick={() => void save(false)}>{t("toolbox.save")}</Button>
                <Button size="sm" variant="secondary" disabled={busy || !draft.content.trim()} onClick={() => void save(true)}>{t("toolbox.prompts.publish")}</Button>
                <span className="spacer" />
                <span className="toolbox-hint">{dirty ? t("toolbox.unsaved") : t("toolbox.prompts.publishHint")}</span>
              </div>

              <div className="toolbox-field">
                <label>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <History className="size-3.5" />
                    {t("toolbox.versions")}
                  </span>
                  <em>{t("toolbox.versionsHint", { count: draft.versions.length })}</em>
                </label>
                {draft.versions.length === 0 ? (
                  <span className="toolbox-hint">{t("toolbox.versionsEmpty")}</span>
                ) : (
                  <div className="toolbox-versions">
                    {[...draft.versions].reverse().map((version) => (
                      <div className="toolbox-version" key={version.v}>
                        <strong>v{version.v}</strong>
                        <time>{timeLabel(version.savedAt, i18n.language)}</time>
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

      <ConfirmDialog
        open={pending !== null}
        title={pending === "delete" ? t("toolbox.prompts.deleteTitle", { name: draft?.title || t("toolbox.prompts.untitled") }) : t("toolbox.discardTitle")}
        body={pending === "delete" ? t("toolbox.prompts.deleteBody") : t("toolbox.discardBody")}
        confirmLabel={pending === "delete" ? t("toolbox.delete") : t("toolbox.discard")}
        danger={pending === "delete"}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending === "delete") { void remove(); return; }
          const next = pending && typeof pending === "object" ? pending.switch : null;
          setPending(null);
          if (next) { setSaved(next.id ? next : null); setDraft(next); }
        }}
      />
    </>
  );
}
