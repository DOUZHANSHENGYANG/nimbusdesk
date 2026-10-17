import { useEffect, useMemo, useRef, useState } from "react";
import { RiLayoutColumnLine as Columns2, RiEyeLine as Eye, RiEditLine as Pencil, RiSaveLine as Save, RiRestartLine as RotateCcw, RiCheckLine as Check, RiCheckboxBlankCircleFill as Circle, RiMoreLine, RiInformationLine, RiExternalLinkLine, RiFolderOpenLine, RiFolderLine } from "@remixicon/react";
import { Button } from "@/components/ui/button";
import { useModal } from "@/components/shell/modal-host";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { readNote, updateNote } from "./api";
import { clearNoteDraft, loadNoteDraft, writeNoteDraft, type NoteDraft } from "./drafts";
import { NoteMarkdown } from "./markdown";
import { useKnowledgeCopy } from "./copy";
import { RecipePreview } from "./recipe";
import type { ReadNote } from "./types";
import { useOrganizationJobs } from './organization-jobs';
import { organizationWritesNote } from './background-organization-core';
import { previewWithoutRepeatedTitle } from './reader-presentation';

type Mode = "preview" | "edit" | "split";

export function NoteReader({ root, note, title, recipe, onOpen, onInfo, onSaved, onDirtyChange }: { root: string; note: ReadNote; title: string; recipe: boolean; onOpen: (mode: "default" | "reveal" | "obsidian") => void; onInfo: () => void; onSaved: (note: ReadNote) => void; onDirtyChange?: (dirty: boolean) => void }) {
  const c = useKnowledgeCopy();
  const writing=useOrganizationJobs(state=>organizationWritesNote(state.job,root,note.path));
  const writeLocked=()=>organizationWritesNote(useOrganizationJobs.getState().job,root,note.path);
  const { confirm } = useModal();
  const [draft, setDraft] = useState<NoteDraft>({ base: note, content: note.content });
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>("preview");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const mounted = useRef(true);
  const latestNote = useRef(note); latestNote.current = note;
  const savingRef = useRef(false);
  const dirty = draft.content !== draft.base.content;
  useEffect(() => { onDirtyChange?.(dirty || saving || !ready); }, [dirty, saving, ready, onDirtyChange]);
  const changedOutside = dirty && note.fingerprint !== draft.base.fingerprint;
  const previewContent = useMemo(() => previewWithoutRepeatedTitle(draft.content, title), [draft.content, title]);

  useEffect(() => {
    mounted.current = true;
    void loadNoteDraft(root, note.path).then((saved) => {
      if (!mounted.current) return;
      const current = latestNote.current;
      if (saved && saved.content !== current.content) {
        setDraft(saved); setMode("split"); setStatus(c.restoredNote);
      } else setDraft({ base: current, content: current.content });
    }).catch(() => { if (mounted.current) setError(c.draftStorageError); })
      .finally(() => { if (mounted.current) setReady(true); });
    return () => { mounted.current = false; };
    // The parent keys readers by vault and path; refreshes must not reload drafts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, note.path]);

  useEffect(() => {
    if (!ready) return;
    setDraft((old) => old.content === old.base.content ? { base: note, content: note.content } : old);
  }, [note, ready]);

  function edit(content: string) {
    if(writeLocked())return;
    const next = { base: draft.base, content };
    setDraft(next); setStatus("");
    void writeNoteDraft(root, next).catch(() => { if (mounted.current) setError(c.draftStorageError); });
  }

  async function save() {
    if (!dirty || !ready || savingRef.current || writeLocked()) return;
    savingRef.current = true; setSaving(true); setError(""); setStatus("");
    const snapshot = draft;
    try {
      const result = await updateNote(root, { path: note.path, content: snapshot.content, fingerprint: snapshot.base.fingerprint });
      try { await clearNoteDraft(root, snapshot); }
      catch { if (mounted.current) setError(c.savedDraftRemains); }
      if (mounted.current) { setDraft({ base: result, content: result.content }); setStatus(c.noteSaved); onSaved(result); }
    } catch (failure) { if (mounted.current) setError(`${c.noteSaveFailed} ${String(failure)}`); }
    finally { savingRef.current = false; if (mounted.current) setSaving(false); }
  }

  async function reload() {
    if(writeLocked())return;
    if (dirty && !await confirm({ title: c.reloadTitle, description: c.reloadHint, confirmText: c.reloadNote, danger: true })) return;
    if (!mounted.current) return;
    savingRef.current = true; setSaving(true); setError("");
    try {
      const result = await readNote(root, note.path);
      await clearNoteDraft(root, draft);
      if (mounted.current) { setDraft({ base: result, content: result.content }); setStatus(c.noteSaved); onSaved(result); }
    } catch (failure) { if (mounted.current) setError(String(failure)); }
    finally { savingRef.current = false; if (mounted.current) setSaving(false); }
  }

  const modes = [{ id: "preview", label: c.preview, icon: Eye }, { id: "edit", label: c.edit, icon: Pencil }, { id: "split", label: c.split, icon: Columns2 }] as const;
  return <section className="knowledge-note-reader" aria-label={c.readingMode} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); } }}>
    <div className="knowledge-editor-toolbar sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background px-5 py-3">
      <div role="group" aria-label={c.modeLabel} className="knowledge-reader-modes flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
        {modes.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-pressed={mode === id} onClick={() => setMode(id)} className={cn("flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring", mode === id ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}><Icon className="size-3.5" />{label}</button>)}
      </div>
      <div className="knowledge-reader-actions flex items-center gap-2">
        {(mode !== "preview" || dirty || saving || status) && <span role="status" className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">{dirty ? <Circle className="size-2 fill-warning text-warning" /> : <Check className="size-3" />}{saving ? c.savingNote : dirty ? c.unsavedNote : status || c.noteSaved}</span>}
        {(mode !== "preview" || dirty) && <Button className="knowledge-note-save" size="sm" disabled={!dirty || !ready || saving || writing} onClick={() => void save()} title="Ctrl+S"><Save className="size-3.5" />{c.saveNote}</Button>}
        <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" title={c.noteMore} aria-label={c.noteMore}><RiMoreLine className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="workbench-ui knowledge-note-menu">
          <DropdownMenuItem onSelect={onInfo}><RiInformationLine />{c.noteInfo}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onOpen("obsidian")}><RiExternalLinkLine />{c.openObsidian}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onOpen("default")}><RiFolderOpenLine />{c.open}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onOpen("reveal")}><RiFolderLine />{c.reveal}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!ready || saving || writing} onSelect={() => void reload()}><RotateCcw />{c.reloadNote}</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
      </div>
    </div>
    <div className="knowledge-reader-heading"><h1>{title}</h1></div>
    {error && <p role="alert" className="m-5 break-words rounded-lg border border-destructive/30 p-3 text-xs leading-6 text-destructive">{error}</p>}
    {changedOutside && <p role="status" className="mx-5 my-3 text-xs leading-6 text-warning">{c.outsideChanged}</p>}
    {writing && <p role="status" className="mx-5 my-3 text-xs leading-6 text-muted-foreground">{c.all==='All'?'Saving organized changes; editing resumes when finished.':'正在写入整理结果，完成后即可继续编辑。'}</p>}
    {!ready ? <p role="status" className="p-7 text-sm text-muted-foreground">{c.loading}</p> : <div className="note-reading-body" data-mode={mode}>
      {mode !== "preview" && <textarea aria-label={c.editorLabel} className="note-source w-full min-w-0 bg-transparent text-foreground" spellCheck={false} readOnly={saving||writing} value={draft.content} onChange={(event) => edit(event.target.value)} />}
      {mode !== "edit" && <div className={cn("knowledge-reader-preview min-w-0 px-7 py-7", mode === "split" && "border-l border-border")}><NoteMarkdown root={root} path={note.path} content={previewContent} onError={setError} />{recipe && <div className="mt-8"><RecipePreview content={draft.content} /></div>}</div>}
    </div>}
    {mode !== "preview" && <p className="border-t border-border px-5 py-3 text-[11px] text-muted-foreground">Ctrl+S · {c.draftKept}</p>}
  </section>;
}
