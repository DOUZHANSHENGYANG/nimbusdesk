import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, GitCompareArrows, LoaderCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useProjects } from "./store";
import { useZentao } from "./zentao-store";
import { useZentaoRuntimeState } from "./zentao-controller";
import { refreshZenTask, resolveZenChanges, sendZenChanges } from "./zentao-writeback-controller";
import { useZenWriteCopy } from "./zentao-writeback-copy";
import type { ZenWriteField } from "./zentao-types";

type Selection = { choice: "local" | "remote" | "edit"; value?: string | null };
const fields: ZenWriteField[] = ["title", "note", "deadline"];

export function ZenWriteSettings({ value, onChange }: { value: ZenWriteField[]; onChange: (value: ZenWriteField[]) => void }) {
  const c = useZenWriteCopy();
  const labels = { title: c.allowTitle, note: c.allowNote, deadline: c.allowDeadline };
  return <fieldset className="space-y-2 border-t border-border pt-3"><legend className="text-xs font-medium">{c.settings}</legend><p className="text-[11px] leading-relaxed text-muted-foreground">{c.settingsHint}</p><div className="flex flex-wrap gap-x-4 gap-y-2">{fields.map(field => <label key={field} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={value.includes(field)} onChange={event => onChange(fields.filter(key => key === field ? event.target.checked : value.includes(key)))} className="size-4 accent-primary" />{labels[field]}</label>)}</div></fieldset>;
}

export function ZenWritebackSource({ remoteTaskId }: { remoteTaskId: string }) {
  const c = useZenWriteCopy(), [open, setOpen] = useState(false);
  const change = useProjects(s => s.remoteChanges?.find(value => value.id === remoteTaskId));
  const status = change?.status === "sending" ? c.sending : change?.status === "uncertain" ? c.uncertain : change?.status === "conflict" ? c.conflict : change?.status === "failed" ? c.failed : c.pending;
  return <><Button variant="ghost" size="sm" className="mt-1 h-7 px-1 text-xs" onClick={() => setOpen(true)}><GitCompareArrows />{change ? `${status} · ${change.fields.length}` : c.compare}</Button>{open && <ZenWritebackReview remoteTaskId={remoteTaskId} onClose={() => setOpen(false)} />}</>;
}

function ZenWritebackReview({ remoteTaskId, onClose }: { remoteTaskId: string; onClose: () => void }) {
  const c = useZenWriteCopy(), state = useProjects(), connections = useZentao(s => s.connections);
  const change = state.remoteChanges?.find(value => value.id === remoteTaskId);
  const link = state.remoteLinks.find(value => value.id === remoteTaskId);
  const connection = connections.find(value => value.id === link?.connectionId);
  const remote = state.remoteTasks.find(value => value.id === remoteTaskId);
  const busy = useZentaoRuntimeState(s => Boolean(s.busy[link?.connectionId ?? ""]));
  const [working, setWorking] = useState(false), [error, setError] = useState("");
  const [selections, setSelections] = useState<Partial<Record<ZenWriteField, Selection>>>({}), [reviewedAt, setReviewedAt] = useState<number | null>(null), [changed, setChanged] = useState(false);
  const stamp = useRef(change?.updatedAt);
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const disabled = busy || working;
  const permitted = Boolean(change && change.fields.every(field => connection?.writeFields?.includes(field)));
  const reviewed = Boolean(change && reviewedAt === change.updatedAt);
  const canReviewSend = change?.status === "pending" || change?.status === "failed";
  const maySend = canReviewSend && permitted && reviewed && !Object.keys(selections).length;
  const labels = { title: c.title, note: c.note, deadline: c.deadline };
  useEffect(() => {
    if (stamp.current !== change?.updatedAt) {
      stamp.current = change?.updatedAt; setSelections({}); setReviewedAt(null); setChanged(true);
    }
  }, [change?.updatedAt]);
  async function run(action: () => Promise<unknown>, message?: string) {
    if (disabled) return;
    setWorking(true); setError(""); setReviewedAt(null);
    try { await action(); if (message) toast.success(message); }
    catch (error) { setError(error instanceof Error ? error.message : c.error); }
    finally { setWorking(false); }
  }
  function choose(field: ZenWriteField, choice: Selection["choice"]) {
    setReviewedAt(null);
    setSelections(current => ({ ...current, [field]: { choice, ...(choice === "edit" ? { value: change?.local[field] ?? null } : {}) } }));
  }
  const status = change?.status === "conflict" ? c.conflict : change?.status === "uncertain" || change?.status === "sending" ? c.uncertain : change?.status === "failed" ? c.failed : c.pending;
  return <Dialog open onOpenChange={open => { if (!open && !disabled) onClose(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl" onEscapeKeyDown={event => { if (disabled) event.preventDefault(); }} onPointerDownOutside={event => { if (disabled) event.preventDefault(); }} onCloseAutoFocus={event => { event.preventDefault(); returnFocus.current?.focus(); }}><DialogHeader><DialogTitle>{c.review}</DialogTitle><DialogDescription>{c.hint}</DialogDescription></DialogHeader>
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{remote?.title}</p><p className="mt-1 text-xs text-muted-foreground">{connection?.name} · #{link?.remoteId}</p></div><Button size="sm" variant="outline" disabled={disabled || !link} onClick={() => void run(() => refreshZenTask(remoteTaskId))}>{disabled ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <RefreshCw />}{c.refresh}</Button></div>
    {changed && <p className="text-xs text-muted-foreground" role="status">{c.changed}</p>}
    {!change ? <p className="py-6 text-center text-sm text-muted-foreground">{c.empty}</p> : <>
      <div className="space-y-1" aria-live="polite"><p className="text-sm font-medium">{status}</p><p className="text-xs leading-relaxed text-muted-foreground">{change.status === "uncertain" || change.status === "sending" ? c.unknownHint : change.status === "conflict" ? c.conflictHint : c.pendingHint}</p>{change.lastError && <p className="break-words text-xs text-destructive">{change.lastError}</p>}</div>
      <div className="space-y-4">{change.fields.map(field => <fieldset key={field} disabled={disabled || change.status === "sending" || change.status === "uncertain"} className="min-w-0 space-y-2 rounded-lg border border-border p-3"><legend className="px-1 text-xs font-medium">{labels[field]}</legend><div className="grid gap-2 sm:grid-cols-3">{([{ key: "base", label: c.base }, { key: "local", label: c.local }, { key: "remote", label: c.remote }] as const).map(column => <div key={column.key} className="min-w-0 rounded bg-muted/50 p-2"><p className="mb-1 text-[11px] text-muted-foreground">{column.label}</p><p className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed">{change[column.key][field] || c.noValue}</p></div>)}</div><div className="flex flex-wrap gap-x-4 gap-y-2">{(["local", "remote", "edit"] as const).map(choice => <label key={choice} className="flex items-center gap-1.5 text-xs"><input type="radio" name={`write-${field}`} aria-label={`${labels[field]} · ${choice === "local" ? c.chooseLocal : choice === "remote" ? c.chooseRemote : c.chooseEdit}`} checked={selections[field]?.choice === choice} onChange={() => choose(field, choice)} className="accent-primary" />{choice === "local" ? c.chooseLocal : choice === "remote" ? c.chooseRemote : c.chooseEdit}</label>)}</div>{selections[field]?.choice === "edit" && (field === "note" ? <Textarea aria-label={`${labels[field]} · ${c.chooseEdit}`} value={selections[field]?.value ?? ""} onChange={event => setSelections(current => ({ ...current, [field]: { choice: "edit", value: event.target.value } }))} rows={4} /> : <Input type={field === "deadline" ? "date" : "text"} aria-label={`${labels[field]} · ${c.chooseEdit}`} value={selections[field]?.value ?? ""} onChange={event => setSelections(current => ({ ...current, [field]: { choice: "edit", value: event.target.value || (field === "deadline" ? null : "") } }))} />)}</fieldset>)}</div>
      {Object.keys(selections).length > 0 && <Button variant="outline" className="justify-self-start" disabled={disabled || change.fields.some(field => !selections[field])} onClick={() => void run(() => resolveZenChanges(remoteTaskId, selections, change.updatedAt), c.applied)}>{c.apply}</Button>}
      {!permitted && <p className="text-xs text-muted-foreground">{c.readOnly}</p>}
      <div className="space-y-3 border-t border-border pt-3"><p className="text-[11px] leading-relaxed text-muted-foreground">{c.noCas}</p><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={reviewed} disabled={disabled || !canReviewSend || !permitted || Object.keys(selections).length > 0} onChange={event => setReviewedAt(event.target.checked ? change.updatedAt : null)} className="size-4 accent-primary" />{c.checked}</label></div>
    </>}
    {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
    <DialogFooter><Button variant="ghost" disabled={disabled} onClick={onClose}>{c.close}</Button>{change && <Button disabled={disabled || !maySend} onClick={() => void run(() => sendZenChanges(remoteTaskId, change.updatedAt), c.sent)}>{disabled ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <ArrowUpRight />}{c.send}</Button>}</DialogFooter>
  </DialogContent></Dialog>;
}
