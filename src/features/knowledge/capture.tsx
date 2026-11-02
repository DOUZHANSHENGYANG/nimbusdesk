import { useEffect, useRef, useState } from "react";
import { FileText, FolderOpen, ImagePlus, Pin, PinOff, Type, X } from "lucide-react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { I18nextProvider } from "react-i18next";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { inTauri, windowReady, pickFolder } from "@/lib/tauri";
import { applyTheme } from "@/lib/theme";
import { onStorageSynced } from "@/lib/storage";
import { i18n } from "@/lib/i18n";
import { useSettings } from "@/stores/settings";
import { useKnowledge } from "./store";
import { bindVault, saveCapture } from "./api";
import { useKnowledgeCopy } from "./copy";
import { OrganizationActivity } from './organization-activity';
import { ensureImageExtension } from "./organize-logic";
import "./workspace.css";
import { loadDraft, newCapture, writeDraft } from "./drafts";
import type { AttachmentInput, CaptureInput } from "./types";

const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_TOTAL = 30 * 1024 * 1024;
const MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
function fileData(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
function withTitle(input: CaptureInput, fallback: string): CaptureInput {
  const title = input.title.trim() ? input.title : input.content.trim().split(/\r?\n/)[0].replace(/^#+\s*/, "").slice(0, 80) || fallback;
  const attachments = input.attachments.map((image) => { const name = ensureImageExtension(image.name, image.mime); return name === image.name ? image : { ...image, name }; });
  return title === input.title && attachments.every((image, index) => image === input.attachments[index]) ? input : { ...input, title, attachments };
}

export interface CaptureFormProps { onSaved?: () => void; onHide?: () => Promise<void> | void }
export function CaptureForm(props: CaptureFormProps) {
  const root = useKnowledge((s) => s.vaultRoot);
  const c = useKnowledgeCopy();
  return root ? <VaultCapture key={root} root={root} {...props} /> : <div className="p-6 text-sm text-muted-foreground">{c.permission}</div>;
}

function VaultCapture({ root, onSaved, onHide }: CaptureFormProps & { root: string }) {
  const c = useKnowledgeCopy();
  const [draft, setDraft] = useState<CaptureInput>(newCapture);
  const draftRef = useRef(draft);
  const revision = useRef(0);
  const generation = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const persistedError = useRef<unknown>(null);
  const recoveryId = useRef(crypto.randomUUID());
  const savedId = useRef<string | null>(null);
  
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const imageDropzone = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let current = true;
    const initialGeneration = generation.current;
    void loadDraft(root).then((stored) => {
      if (!current || !mounted.current) return;
      if (stored && generation.current === initialGeneration) {
        generation.current += 1;
        revision.current = stored.revision; draftRef.current = stored.input; setDraft(stored.input);
      }
      setReady(true);
    }).catch((e) => { if (current && mounted.current) setError(String(e)); });
    return () => { current = false; mounted.current = false; };
  }, [root]);
  useEffect(() => {
    const sync = async () => {
      const queued = queue.current;
      const localGeneration = generation.current;
      await queued;
      if (queue.current !== queued || generation.current !== localGeneration || persistedError.current || busyRef.current) return;
      const localRevision = revision.current;
      const stored = await loadDraft(root);
      // Reading IndexedDB yields. Never apply an older read over typing, image
      // imports, a save, or a newer focus synchronization started meanwhile.
      if (!mounted.current || generation.current !== localGeneration || queue.current !== queued || busyRef.current || persistedError.current || revision.current !== localRevision || !stored || stored.revision === revision.current) return;
      generation.current += 1;
      revision.current = stored.revision; draftRef.current = stored.input; setDraft(stored.input);
    };
    const focus = () => { void sync().catch((e) => setError(String(e))); };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [root]);

  function update(next: CaptureInput) {
    generation.current += 1;
    // If capture succeeded but draft cleanup failed, editing starts a new entry.
    // An unchanged retry keeps its original ID and is idempotent in the native layer.
    if (savedId.current === next.id) {
      next = { ...next, id: crypto.randomUUID() };
      savedId.current = null; setError(""); setNotice(c.saved);
    }
    draftRef.current = next;
    setDraft(next);
    setPending((n) => n + 1);
    queue.current = queue.current.then(async () => {
      try {
        revision.current = await writeDraft(root, next, revision.current);
        persistedError.current = null;
      } catch (e) {
        persistedError.current = e;
        if (mounted.current) setError(String(e).includes("DRAFT_CONFLICT") ? c.draftConflict : c.draftError);
      } finally { if (mounted.current) setPending((n) => n - 1); }
    });
  }
  function patch(values: Partial<CaptureInput>) { update({ ...draftRef.current, ...values }); }
  async function addFiles(files: File[]) {
    if (!ready || busyRef.current || files.length === 0) return;
    const existing = draftRef.current.attachments;
    const size = existing.reduce((sum, image) => sum + image.dataBase64.length * 3 / 4, 0);
    if (files.some((file) => !MIME.has(file.type) || file.size > MAX_IMAGE) || existing.length + files.length > 10 || size + files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL) { setError(c.badImage); return; }
    generation.current += 1;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const images = await Promise.all(files.map(async (file): Promise<AttachmentInput> => ({ name: file.name || `${c.defaultImage}-${Date.now()}.${file.type === "image/jpeg" ? "jpg" : file.type.slice(6)}`, mime: file.type, dataBase64: await fileData(file) })));
      patch({ attachments: [...draftRef.current.attachments, ...images] });
      requestAnimationFrame(() => imageDropzone.current?.scrollIntoView({ block: "nearest" }));
    } catch (e) { setError(String(e)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function hide() {
    if (busyRef.current) return;
    await queue.current;
    if (persistedError.current) return;
    await onHide?.();
  }
  async function recoverDraft(saveLocal: boolean) {
    if (busyRef.current) return;
    generation.current += 1;
    busyRef.current = true; setBusy(true);
    try {
      await queue.current;
      if (saveLocal) {
        const input = withTitle(draftRef.current, c.untitled);
        if (!input.content.trim() && input.attachments.length === 0) throw new Error(c.needContent);
        draftRef.current = input; setDraft(input);
        if (savedId.current !== input.id) await saveCapture(root, { ...input, id: recoveryId.current });
        onSaved?.();
      }
      const stored = await loadDraft(root);
      const next = stored?.input ?? newCapture();
      revision.current = stored?.revision ?? 0; draftRef.current = next; setDraft(next);
      persistedError.current = null; setError(""); setReady(true);
      savedId.current = null;
      if (saveLocal) setNotice(c.saved);
      recoveryId.current = crypto.randomUUID();
    } catch (e) { setError(String(e)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function save() {
    if (!ready || busyRef.current) return;
    const input = withTitle(draftRef.current, c.untitled);
    if (!input.content.trim() && input.attachments.length === 0) { setError(c.needContent); return; }
    generation.current += 1;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    let saved = false;
    try {
      if (input !== draftRef.current) update(input);
      await queue.current;
      if (persistedError.current) throw persistedError.current;
      await saveCapture(root, input);
      savedId.current = input.id;
      saved = true;
      const next = newCapture();
      // Persist the new empty draft before replacing successful input in the UI.
      revision.current = await writeDraft(root, next, revision.current);
      savedId.current = null; draftRef.current = next; setDraft(next); setNotice(c.saved); onSaved?.();
    } catch (e) {
      if (String(e).includes("DRAFT_CONFLICT")) persistedError.current = e;
      setError(saved ? `${c.savedDraftIssue} ${String(e)}` : String(e));
    }
    finally { busyRef.current = false; setBusy(false); }
  }
  const actions = useRef({ save, hide }); actions.current = { save, hide };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('[data-organization-workspace="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void actions.current.save(); }
      if (event.key === "Escape" && onHide) { event.preventDefault(); void actions.current.hide(); }
    };
    window.addEventListener("keydown", key);
    const hideRequest = () => { void actions.current.hide(); };
    window.addEventListener("knowledge:capture-hide", hideRequest);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("knowledge:capture-hide", hideRequest); };
  }, [onHide]);
  return <div className="workbench-ui capture-composer" onPaste={(e) => {
    const files = Array.from(e.clipboardData.items).filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter((file): file is File => !!file);
    if (files.length) { e.preventDefault(); void addFiles(files); }
  }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void addFiles(Array.from(e.dataTransfer.files)); }}>
    <fieldset disabled={!ready || busy} className="capture-fields disabled:opacity-60">
      <section className="capture-writing">
        <label className="capture-title-label"><span className="capture-field-label"><Type aria-hidden="true" />{c.titleField}</span><Input aria-label={c.optionalTitle} value={draft.title} onChange={(event) => patch({ title: event.target.value })} /></label>
        <label className="capture-body-label"><span className="capture-field-label"><FileText aria-hidden="true" />{c.content}<i className="capture-required" aria-hidden="true">*</i></span><Textarea aria-label={c.content} value={draft.content} onChange={(event) => patch({ content: event.target.value })} /></label>
      </section>
      <section className="capture-attachments" aria-label={c.imageAttachments}>
        <div className="capture-field-heading"><span className="capture-field-label"><ImagePlus aria-hidden="true" />{c.imageAttachments}{draft.attachments.length > 0 && <span className="capture-count">{draft.attachments.length}/10</span>}</span></div>
        <input ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(event) => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        {draft.attachments.length > 0 && <div className="capture-image-list">{draft.attachments.map((image, index) => <div key={index} className="capture-image-row">
          <img src={`data:${image.mime};base64,${image.dataBase64}`} alt={image.name} />
          {editing === index
            ? <Input autoFocus aria-label={`${c.imageName} ${index + 1}`} value={image.name}
              onChange={(event) => patch({ attachments: draft.attachments.map((item, i) => i === index ? { ...item, name: event.target.value } : item) })}
              onBlur={() => { const next = ensureImageExtension(image.name, image.mime); if (next !== image.name) patch({ attachments: draftRef.current.attachments.map((item, i) => i === index ? { ...item, name: next } : item) }); setEditing(null); }}
              onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }} />
            : <button type="button" className="capture-image-label" title={c.renameHint} onDoubleClick={() => setEditing(index)}>{ensureImageExtension(image.name, image.mime)}</button>}
          <Button variant="ghost" size="icon" aria-label={`${c.remove} ${index + 1}`} title={c.remove} onClick={() => patch({ attachments: draft.attachments.filter((_, i) => i !== index) })}><X /></Button>
        </div>)}</div>}
        <button ref={imageDropzone} type="button" className="capture-dropzone" aria-label={draft.attachments.length ? c.continueImages : c.images} title={draft.attachments.length >= 10 ? c.imageLimitReached : c.limits} disabled={draft.attachments.length >= 10} onClick={() => fileInput.current?.click()}>
          <ImagePlus aria-hidden="true" /><span>{draft.attachments.length ? c.continueImages : c.images}</span>
        </button>
      </section>
    </fieldset>
    {error && <div role="alert" className="workbench-notice space-y-2 text-destructive"><p>{error}</p>{String(persistedError.current).includes("DRAFT_CONFLICT") ? <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => void recoverDraft(true)}>{c.saveLocal}</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => void recoverDraft(false)}>{c.loadLatest}</Button></div> : <Button variant="outline" size="sm" disabled={busy} onClick={() => { if (!ready) void recoverDraft(false); else if (persistedError.current) update(draftRef.current); else void save(); }}>{c.retry}</Button>}</div>}
    {notice && <p role="status" className="capture-notice">{notice}</p>}
    <footer className="capture-footer">
      <Button disabled={!ready || busy || pending > 0} onClick={() => void save()}>{busy ? c.saving : c.save}</Button>
    </footer>
    <OrganizationActivity compact/>

  </div>;
}

export function CaptureWindow() {
  const theme = useSettings((s) => s.theme);
  const lang = useSettings((s) => s.lang);
  const root = useKnowledge((s) => s.vaultRoot);
  const name = useKnowledge((s) => s.vaultName);
  const c = useKnowledgeCopy();
  const [pinned, setPinned] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => { document.documentElement.lang = lang; void i18n.changeLanguage(lang); }, [lang]);
  useEffect(() => onStorageSynced((key, value) => {
    if (key !== "settings") return;
    const state = (value as { state?: { theme?: string; lang?: string } })?.state;
    if (!state) return;
    if (state.theme === "light" || state.theme === "dark") useSettings.setState({ theme: state.theme });
    if (state.lang === "zh" || state.lang === "en") useSettings.setState({ lang: state.lang });
  }), []);
  useEffect(() => { if (inTauri) void windowReady().catch((e) => setError(String(e))); }, []);
  const hide = async () => { if (inTauri) await getCurrentWebviewWindow().hide(); };
  function requestHide() { if (root) window.dispatchEvent(new Event("knowledge:capture-hide")); else void hide(); }
  const closeRef = useRef(requestHide); closeRef.current = requestHide;
  useEffect(() => {
    if (!inTauri) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebviewWindow().onCloseRequested((event) => { event.preventDefault(); closeRef.current(); }).then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch((e) => setError(String(e)));
    return () => { disposed = true; unlisten?.(); };
  }, []);
  async function bind() {
    try { const selected = await pickFolder(); if (!selected) return; const vault = await bindVault(selected); useKnowledge.getState().setVault(vault.root, vault.name); }
    catch (e) { setError(String(e)); }
  }
  return <I18nextProvider i18n={i18n}><TooltipProvider><div className="workbench-ui capture-window">
    <header data-tauri-drag-region className="capture-window-header">
      <div className="capture-window-title"><img src="/app-icon.png" alt="" /><div><h1>{c.capture}</h1><p>{name || c.bind}</p></div></div><div className="flex gap-1">
        <Button variant="ghost" size="icon" aria-label={pinned ? c.unpin : c.pin} aria-pressed={pinned} title={pinned ? c.unpin : c.pin} onClick={() => {
          if (!inTauri) { setPinned(!pinned); return; }
          void getCurrentWebviewWindow().setAlwaysOnTop(!pinned).then(() => setPinned(!pinned)).catch((e) => setError(String(e)));
        }}>{pinned ? <Pin /> : <PinOff />}</Button>
        <Button variant="ghost" size="icon" aria-label={c.hide} title={c.hide} onClick={requestHide}><X /></Button>
      </div>
    </header>
    <main className="capture-window-main">{error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}{root ? <CaptureForm onHide={hide} /> : <div className="space-y-4"><p className="text-sm text-muted-foreground">{c.unbound}</p><Button onClick={() => void bind()}><FolderOpen />{c.bind}</Button></div>}</main>
  </div></TooltipProvider></I18nextProvider>;
}
