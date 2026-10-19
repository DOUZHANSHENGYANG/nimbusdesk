import { useDeferredValue, useRef, useState } from "react";
import { ExternalLink, Link2, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { usePlans, usePlansArchive } from "@/features/plans/store";
import { useProjects } from "./store";
import { useZentao } from "./zentao-store";
import { bindZenTask, openZenTask } from "./zentao-controller";
import { resolvePlanWorkItem } from "./core";
import { ProjectSelect } from "./forms";
import { useZenCopy } from "./zentao-copy";
import { remoteFields } from "./zentao-core";
import { ZenWritebackSource } from "./zentao-writeback-panel";
import type { ZenFields } from "./zentao-types";

export function ZenSource({ itemId }: { itemId: string }) {
  const c = useZenCopy(), state = useProjects(), connections = useZentao(s => s.connections);
  const link = state.remoteLinks.find(value => value.itemId === itemId);
  if (!link) return null;
  const connection = connections.find(value => value.id === link.connectionId), task = state.remoteTasks.find(value => value.id === link.id);
  const execution = state.remoteExecutions.find(value => value.connectionId === link.connectionId && value.remoteId === task?.executionId);
  const labels: Record<string, string> = { title: c.titleField, note: c.noteField, deadline: c.deadlineField, status: c.statusField };
  return <div className="space-y-1 rounded-lg border border-border px-3 py-2"><span className="block text-[11px] text-muted-foreground">{c.source}</span><Button variant="link" size="sm" className="h-auto max-w-full justify-start p-0 text-left" aria-label={c.open} onClick={() => { void openZenTask(link.id).catch(() => toast.error(c.failed)); }}><span className="min-w-0 truncate">{connection?.name ?? c.noName} · #{link.remoteId}{execution ? ` · ${execution.name}` : ""}</span><ExternalLink className="shrink-0" /></Button>{link.divergedFields.length > 0 && <details className="pt-1 text-[11px] text-muted-foreground"><summary className="cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-ring">{c.localChanges} · {link.divergedFields.map(key => labels[key] ?? key).join(" / ")}</summary><div className="mt-2 space-y-2 border-t border-border pt-2">{link.divergedFields.map(key => <p key={key} className="max-h-24 overflow-auto whitespace-pre-wrap break-words">{labels[key] ?? key} · {c.baseline}: {link.baseline[key as keyof ZenFields] || c.none}</p>)}</div></details>}<ZenWritebackSource remoteTaskId={link.id} /></div>;
}

export function ZenBinding({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const c = useZenCopy(), state = useProjects(), connections = useZentao(s => s.connections), days = usePlans(s => s.days), archived = usePlansArchive(s => s.days);
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const returnArea = useRef(returnFocus.current?.closest("aside"));
  const [search, setSearch] = useState(""), [connectionId, setConnectionId] = useState("all"), [selectedId, setSelectedId] = useState("");
  const [choices, setChoices] = useState<Partial<Record<keyof ZenFields, "local" | "remote">>>({}), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const query = useDeferredValue(search.trim().toLocaleLowerCase()), item = state.items.find(value => value.id === itemId);
  const selected = state.remoteTasks.find(value => value.id === selectedId), currentLink = state.remoteLinks.find(value => value.itemId === itemId);
  const donorLink = selected ? state.remoteLinks.find(value => value.id === selected.id && value.itemId !== itemId) : undefined;
  const donor = state.items.find(value => value.id === donorLink?.itemId);
  const matches = state.remoteTasks.filter(task => (connectionId === "all" || task.connectionId === connectionId) && (!query || [task.title, String(task.remoteId), connections.find(value => value.id === task.connectionId)?.name].some(value => value?.toLocaleLowerCase().includes(query))));
  const counts = (id: string) => ({ plans: [...Object.values(days), ...Object.values(archived).map(day => day.tasks)].reduce((count, tasks) => count + tasks.filter(task => resolvePlanWorkItem(tasks, task.id) === id).length, 0), history: state.memberships.filter(value => value.itemId === id).length });
  async function confirm() {
    if (!selected || saving) return;
    setSaving(true); setError("");
    try {
      const result = await bindZenTask(itemId, selected.id, choices);
      toast.success(c.bound, result.undo ? { action: { label: c.undo, onClick: () => { void result.undo!().catch(() => toast.error(c.undoFailed)); } }, duration: 12000 } : undefined);
      onClose();
    } catch { setError(c.failed); } finally { setSaving(false); }
  }
  const fields: { key: keyof ZenFields; label: string }[] = [{ key: "title", label: c.titleField }, { key: "note", label: c.noteField }, { key: "deadline", label: c.deadlineField }, { key: "status", label: c.statusField }];
  const donorDifferences = donor && selected ? fields.filter(({ key }) => donor[key] !== remoteFields(selected)[key]) : [];
  function displayValue(key: keyof ZenFields, value: string | null | undefined): string {
    if (key === "status") return c[value as "todo" | "doing" | "done" | "cancelled"] ?? value ?? c.none;
    return value || c.none;
  }
  function fieldValue(key: keyof ZenFields, remote: boolean): string {
    const value = remote && selected ? remoteFields(selected)[key] : item?.[key];
    return displayValue(key, value);
  }
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus(); else returnArea.current?.querySelector<HTMLButtonElement>("button")?.focus(); }} onEscapeKeyDown={event => { if (saving) event.preventDefault(); }} onPointerDownOutside={event => { if (saving) event.preventDefault(); }}><DialogHeader><DialogTitle>{c.bindTitle}</DialogTitle><DialogDescription>{c.bindHint}</DialogDescription></DialogHeader>
    {!item || currentLink ? <p className="text-sm text-muted-foreground">{c.alreadyBound}</p> : !selected ? <div className="grid gap-3"><Input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder={c.search} aria-label={c.search} /><ProjectSelect label={c.title} value={connectionId} onChange={setConnectionId} options={[{ value: "all", label: c.all }, ...connections.map(value => ({ value: value.id, label: value.name }))]} /><p className="text-xs text-muted-foreground" aria-live="polite">{matches.length} {c.found}</p><div className="max-h-[45dvh] space-y-1 overflow-y-auto" aria-label={c.select}>{!matches.length && <p className="py-6 text-center text-sm text-muted-foreground">{c.noTasks}</p>}{matches.slice(0, 100).map(task => { const connection = connections.find(value => value.id === task.connectionId), execution = state.remoteExecutions.find(value => value.connectionId === task.connectionId && value.remoteId === task.executionId); return <button key={task.id} type="button" className="flex w-full min-w-0 items-start gap-2 rounded-lg border border-border p-3 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setSelectedId(task.id); setChoices({}); setError(""); }}><Link2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span className="min-w-0"><span className="block break-words text-sm">{task.title}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{connection?.name ?? c.noName} · #{task.remoteId}{execution ? ` · ${execution.name}` : ""}</span></span></button>; })}</div>{matches.length > 100 && <p className="text-xs text-muted-foreground">{c.firstMatches}</p>}</div> : <div className="grid gap-4">
      <div className="rounded-lg bg-muted/50 p-3"><p className="text-xs text-muted-foreground">{connections.find(value => value.id === selected.connectionId)?.name} · #{selected.remoteId}</p><p className="mt-1 break-words font-medium">{selected.title}</p></div>
      {donor && <div className="space-y-2 rounded-lg border border-amber-500/40 p-3" data-zen-merge-preview><h3 className="font-medium">{c.merge}</h3><p className="text-xs leading-relaxed">{c.mergeHint}</p><div className="grid gap-2 sm:grid-cols-2">{[{ item, label: c.current }, { item: donor, label: c.imported }].map(value => { const count = counts(value.item.id); return <div key={value.item.id} className="min-w-0 rounded bg-muted/50 p-2"><p className="text-[11px] text-muted-foreground">{value.label}</p><p className="break-words text-sm">{value.item.title}</p><p className="mt-1 text-[11px] text-muted-foreground">{count.plans} {c.plans} · {count.history} {c.history}</p></div>; })}</div><p className="text-xs leading-relaxed text-muted-foreground">{c.preserve}</p></div>}
      {donor && donorDifferences.length > 0 && <div className="space-y-2 rounded-lg border border-border p-3" data-zen-donor-differences><h3 className="text-xs font-medium">{c.donorChanges}</h3><p className="text-xs leading-relaxed text-muted-foreground">{c.donorPreserved}</p><table className="w-full table-fixed text-left text-xs"><thead><tr className="text-muted-foreground"><th scope="col" className="w-1/5 py-2 pr-2 font-normal">{c.field}</th><th scope="col" className="w-2/5 px-2 py-2 font-normal">{c.donorOriginal}</th><th scope="col" className="w-2/5 py-2 pl-2 font-normal">{c.cachedSource}</th></tr></thead><tbody>{donorDifferences.map(({ key, label }) => <tr key={key} className="border-t border-border align-top"><th scope="row" className="py-2 pr-2 font-normal text-muted-foreground">{label}</th><td className="px-2 py-2"><p className="max-h-24 overflow-auto whitespace-pre-wrap break-words">{displayValue(key, donor[key])}</p></td><td className="py-2 pl-2"><p className="max-h-24 overflow-auto whitespace-pre-wrap break-words">{displayValue(key, remoteFields(selected)[key])}</p></td></tr>)}</tbody></table></div>}
      <div className="grid gap-3">{fields.map(({ key, label }) => <fieldset key={key} disabled={saving} className="min-w-0"><legend className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</legend><div className="grid gap-2 sm:grid-cols-2">{(["local", "remote"] as const).map(value => <label key={value} className="flex min-w-0 cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-xs has-[:checked]:border-primary"><input type="radio" name={`zen-${key}`} value={value} checked={(choices[key] ?? "local") === value} onChange={() => setChoices({ ...choices, [key]: value })} className="mt-0.5 accent-primary" /><span className="min-w-0"><span className="block text-muted-foreground">{value === "local" ? c.local : c.remote}</span><span className="mt-1 block max-h-28 overflow-y-auto whitespace-pre-wrap break-words">{fieldValue(key, value === "remote")}</span></span></label>)}</div></fieldset>)}</div>
    </div>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <DialogFooter>{selected && <Button variant="ghost" disabled={saving} onClick={() => setSelectedId("")}>{c.back}</Button>}<Button variant="ghost" disabled={saving} onClick={onClose}>{c.close}</Button>{selected && !currentLink && <Button disabled={saving} onClick={() => void confirm()}>{saving && <LoaderCircle className="animate-spin motion-reduce:animate-none" />}{donor ? c.confirmMerge : c.confirm}</Button>}</DialogFooter>
  </DialogContent></Dialog>;
}
