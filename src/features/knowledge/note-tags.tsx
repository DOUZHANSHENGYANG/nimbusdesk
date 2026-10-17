import { useEffect, useRef, useState } from "react";
import { RiHashtag as Hash, RiMagicLine as Sparkles } from "@remixicon/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { chatWithProvider } from "@/features/ai/client";
import { useProviders } from "@/features/ai/providers";
import { ProviderSettings } from "@/features/ai/provider-settings";
import { updateNote } from "./api";
import { useKnowledgeCopy } from "./copy";
import { normalizeTags, tagsFromContent, withTags } from "./metadata";
import { suggestNoteTags } from "./tag-suggestions";
import type { ReadNote } from "./types";

export function NoteTags({ root, note, disabled, onUpdated, onSelect }: { root: string; note: ReadNote; disabled: boolean; onUpdated: (note: ReadNote) => void; onSelect: (tag: string) => void }) {
  const c = useKnowledgeCopy();
  let tags: string[] = []; let parseError = "";
  try { tags = tagsFromContent(note.content); } catch (failure) { parseError = String(failure); }
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(tags.join(", "));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const defaultId = useProviders((state) => state.defaultTextId);
  const mounted = useRef(true);
  const running = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function suggest() {
    if (running.current || disabled) return;
    if (!defaultId) { setSetup(true); return; }
    running.current = true; setBusy(true); setError("");
    try {
      const proposed = await suggestNoteTags({ path: note.path, content: note.content }, chatWithProvider);
      if (mounted.current) { setText(normalizeTags([...tags, ...proposed]).join(", ")); setEditing(true); }
    } catch (failure) { if (mounted.current) setError(String(failure)); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  }
  async function save() {
    if (running.current || disabled) return;
    running.current = true; setBusy(true); setError("");
    try {
      const result = await updateNote(root, { path: note.path, content: withTags(note.content, text.split(/[,，]/)), fingerprint: note.fingerprint });
      if (mounted.current) { setEditing(false); onUpdated(result); }
    } catch (failure) { if (mounted.current) setError(String(failure)); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  }
  return <div className="knowledge-note-tags space-y-2 border-t border-border/50 pt-3">
    <div className="flex flex-wrap items-center gap-2"><Hash className="size-3.5 text-muted-foreground" />{tags.map((tag) => <button key={tag} className="rounded bg-brand/10 px-1.5 py-0.5 text-[11px] text-brand hover:bg-brand/20" onClick={() => onSelect(tag)}>{tag}</button>)}{!tags.length && <span className="text-[11px] text-muted-foreground">{c.noTags}</span>}<div className="ml-auto flex gap-1"><Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled={disabled || busy || !!parseError} title={disabled ? c.saveBeforeAI : undefined} onClick={() => { setText(tags.join(", ")); setEditing((old) => !old); }}>{c.editTags}</Button><Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled={disabled || busy || !!parseError} onClick={() => void suggest()}><Sparkles className="size-3" />{busy ? c.busy : c.suggestTags}</Button></div></div>
    {setup && <ProviderSettings />}
    {editing && <div className="space-y-2"><div className="flex gap-2"><Input aria-label={c.tags} value={text} onChange={(event) => setText(event.target.value)} disabled={busy || disabled} /><Button size="sm" disabled={busy || disabled} onClick={() => void save()}>{c.applyTags}</Button></div><p className="text-[11px] text-muted-foreground">{c.tagAIHint}</p></div>}
    {(error || parseError) && <p role="alert" className="text-xs text-destructive">{error || parseError}</p>}
  </div>;
}
