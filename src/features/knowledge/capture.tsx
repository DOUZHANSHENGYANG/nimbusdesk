import { useEffect, useRef, useState } from "react";
import { RiPushpinLine, RiPushpin2Line, RiCloseLine, RiImageAddLine, RiFolderOpenLine, RiSparklingLine, RiCheckboxCircleLine, RiArrowRightLine, RiFileTextLine } from "@remixicon/react";
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
import { startOrganization } from './background-organization';
import { OrganizationActivity } from './organization-activity';
import { useOrganizationJobs } from './organization-jobs';
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
  const job=useOrganizationJobs(state=>state.job);
  const organizing=job?.status==='running'||job?.status==='stopping';
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
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
  async function organizeDraft() {
    if (!ready || busyRef.current) return;
    const input = withTitle(draftRef.current, c.untitled);
    if (!input.content.trim() && !input.attachments.length) { setError(c.needContent); return; }
    generation.current++;
    busyRef.current = true; setBusy(true); setError("");
    try {
      if (input !== draftRef.current) update(input);
      await queue.current;
      if (persistedError.current) throw persistedError.current;
      const capture = await saveCapture(root, input);
      savedId.current = input.id;
      await startOrganization({root,paths:[capture.notePath],trigger:'capture'});
      const next=newCapture();
      revision.current=await writeDraft(root,next,revision.current);
      savedId.current=null;draftRef.current=next;setDraft(next);
      if (mounted.current) { setNotice(c.all==='All'?'Saved and queued for background organization. You can keep capturing.':'已保存并提交后台整理，可以继续收集。'); onSaved?.(); }
    } catch (failure) { if (mounted.current) setError(String(failure)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
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
        <label className="capture-title-label"><span>{c.titleField}<em>{c.optional}</em></span><Input aria-label={c.optionalTitle} placeholder={c.titleExample} value={draft.title} onChange={(event) => patch({ title: event.target.value })} /></label>
        <label className="capture-body-label"><span><RiFileTextLine aria-hidden="true" />{c.content}</span><Textarea aria-label={c.content} placeholder={c.writeSomething} value={draft.content} onChange={(event) => patch({ content: event.target.value })} /></label>
      </section>
      <section className="capture-context" aria-label={c.linkedContext}>
        <div className="capture-section-heading"><h2>{c.linkedContext}</h2><span>{c.optional}</span></div>
        <div className="capture-context-fields"><label><RiFolderOpenLine aria-hidden="true" /><Input aria-label={c.project} title={c.project} placeholder={c.originalProject} value={draft.project} onChange={(event) => patch({ project: event.target.value })} /></label><label><RiArrowRightLine aria-hidden="true" /><Input aria-label={c.source} title={c.source} placeholder={c.originalSource} value={draft.source} onChange={(event) => patch({ source: event.target.value })} /></label></div>
      </section>
      <section className="capture-attachments" aria-label={c.imageAttachments}>
        <div className="capture-section-heading"><h2>{c.imageAttachments}{draft.attachments.length > 0 && <span className="capture-count">{draft.attachments.length}/10</span>}</h2><Button variant="ghost" size="sm" disabled={draft.attachments.length >= 10} onClick={() => fileInput.current?.click()}><RiImageAddLine />{c.images}</Button></div>
        <input ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(event) => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        {draft.attachments.length > 0 && <>
          <p className="capture-naming-hint">{c.imageNamingHint}</p>
          <div className="capture-image-list">{draft.attachments.map((image, index) => <div key={index} className="capture-image-card">
            <img src={`data:${image.mime};base64,${image.dataBase64}`} alt={image.name} />
            <div className="capture-image-name"><label><span>{c.imageName} <span className="capture-image-number">{String(index + 1).padStart(2, "0")}</span></span><Input aria-label={`${c.imageName} ${index + 1}`} placeholder={c.imageName} value={image.name} onChange={(event) => patch({ attachments: draft.attachments.map((item, i) => i === index ? { ...item, name: event.target.value } : item) })} onBlur={() => { const name = ensureImageExtension(image.name, image.mime); if (name !== image.name) patch({ attachments: draftRef.current.attachments.map((item, i) => i === index ? { ...item, name } : item) }); }} /></label><p title={ensureImageExtension(image.name, image.mime)}><span>{c.imageLiveName}</span>{ensureImageExtension(image.name, image.mime)}</p></div>
            <Button variant="ghost" size="icon" aria-label={`${c.remove} ${index + 1}`} title={c.remove} onClick={() => patch({ attachments: draft.attachments.filter((_, i) => i !== index) })}><RiCloseLine /></Button>
          </div>)}</div>
        </>}
        <button ref={imageDropzone} type="button" className={`capture-dropzone${draft.attachments.length ? " capture-dropzone--continue" : ""}`} aria-label={draft.attachments.length ? c.continueImages : c.fileDrop} disabled={draft.attachments.length >= 10} onClick={() => fileInput.current?.click()}>
          <span className="workbench-icon"><RiImageAddLine aria-hidden="true" /></span><span>{draft.attachments.length ? c.continueImages : c.fileDrop}<small>{draft.attachments.length >= 10 ? c.imageLimitReached : draft.attachments.length ? c.continueImagesHint : c.limits}</small></span>
        </button>
      </section>
    </fieldset>
    {error && <div role="alert" className="workbench-notice space-y-2 text-destructive"><p>{error}</p>{String(persistedError.current).includes("DRAFT_CONFLICT") ? <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => void recoverDraft(true)}>{c.saveLocal}</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => void recoverDraft(false)}>{c.loadLatest}</Button></div> : <Button variant="outline" size="sm" disabled={busy} onClick={() => { if (!ready) void recoverDraft(false); else if (persistedError.current) update(draftRef.current); else void save(); }}>{c.retry}</Button>}</div>}
    {notice && <p role="status" className="capture-notice">{notice}</p>}
    <footer className="capture-footer">
      <div className="capture-footer-status"><span role="status"><RiCheckboxCircleLine aria-hidden="true" />{!ready ? c.loadingDraft : pending ? c.draftSaving : persistedError.current ? c.draftError : c.draftSaved}</span><p>{c.imageNameContext}</p></div>
      <div className="capture-actions"><Button variant="outline" disabled={!ready || busy || pending > 0} onClick={() => void save()}>{busy ? c.saving : c.save}</Button><Button disabled={!ready || busy || pending > 0 || organizing} onClick={() => void organizeDraft()}><RiSparklingLine />{c.captureAI}</Button></div>
      {onHide && <p className="capture-shortcuts"><kbd>Ctrl</kbd> + <kbd>Enter</kbd><span>{c.save}</span><i /><kbd>Esc</kbd><span>{c.hide}</span></p>}
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
      <div className="capture-window-title"><img src="/app-icon.png" alt="" /><div><h1>{c.capture}</h1><p>{c.captureSubtitle}</p></div></div><div className="flex gap-1">
        <Button variant="ghost" size="icon" aria-label={pinned ? c.unpin : c.pin} aria-pressed={pinned} title={pinned ? c.unpin : c.pin} onClick={() => {
          if (!inTauri) { setPinned(!pinned); return; }
          void getCurrentWebviewWindow().setAlwaysOnTop(!pinned).then(() => setPinned(!pinned)).catch((e) => setError(String(e)));
        }}>{pinned ? <RiPushpinLine /> : <RiPushpin2Line />}</Button>
        <Button variant="ghost" size="icon" aria-label={c.hide} title={c.hide} onClick={requestHide}><RiCloseLine /></Button>
      </div>
    </header>
    <main className="capture-window-main"><div className="capture-destination"><span className="workbench-eyebrow">{c.captureDestination}</span><span title={root || undefined}><RiFolderOpenLine aria-hidden="true" />{name || c.bind}</span></div>{error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}{root ? <CaptureForm onHide={hide} /> : <div className="space-y-4"><p className="text-sm text-muted-foreground">{c.unbound}</p><Button onClick={() => void bind()}><RiFolderOpenLine />{c.bind}</Button></div>}</main>
  </div></TooltipProvider></I18nextProvider>;
}
