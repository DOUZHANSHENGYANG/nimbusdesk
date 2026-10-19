import { useMemo, useState } from "react";
import { ArrowRight, Bell, CalendarPlus, Check, Circle, CircleDashed, ExternalLink, Pencil, X, ArrowRightLeft, History } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { usePlans, usePlansArchive } from "@/features/plans/store";
import { todayStr } from "@/features/plans/types";
import { flushAllStorage } from "@/lib/storage";
import { useProjects } from "./store";
import { resolvePlanWorkItem, itemDeadline } from "./core";
export { itemDeadline } from "./core";
import { Field, ProjectSelect, type ItemRecord } from "./forms";
import { useProjectsCopy, type ProjectsCopy } from "./copy";
import { ZenBinding, ZenSource } from "./zentao-binding";
import { useZenCopy } from "./zentao-copy";

export function StatusMark({ status, className = "" }: { status: ItemRecord["status"]; className?: string }) {
  if (status === "done") return <Check className={`size-4 text-emerald-600 dark:text-emerald-400 ${className}`} />;
  if (status === "doing") return <CircleDashed className={`size-4 text-primary ${className}`} />;
  if (status === "cancelled") return <X className={`size-4 text-muted-foreground ${className}`} />;
  return <Circle className={`size-4 text-muted-foreground ${className}`} />;
}
export function deadlineLabel(date: string | null, c: ProjectsCopy): string {
  if (!date) return c.noDeadline;
  const today = todayStr();
  return date === today ? c.dueToday : `${date.slice(5).replace("-", "/")}${date < today ? ` · ${c.overdue}` : ""}`;
}
export function ItemDetails({ item, onClose, onEdit, onReminder }: { item: ItemRecord; onClose: () => void; onEdit: () => void; onReminder: () => void }) {
  const c = useProjectsCopy(), z = useZenCopy(), state = useProjects(), navigate = useNavigate();
  const [zenOpen, setZenOpen] = useState(false);
  const hasZenSource = state.remoteLinks.some(link => link.itemId === item.id);
  const days = usePlans(s => s.days), archived = usePlansArchive(s => s.days);
  const [action, setAction] = useState<"carry" | "plan" | null>(null), [target, setTarget] = useState(item.activeIterationId ?? "none"), [planDate, setPlanDate] = useState(todayStr()), [planTitle, setPlanTitle] = useState(item.title), [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const project = state.projects.find(p => p.id === item.projectId), iteration = state.iterations.find(i => i.id === item.activeIterationId);
  const area = state.areas.find(a => a.id === (item.areaId ?? project?.areaId));
  const deadline = itemDeadline(item, state.iterations);
  const history = state.memberships.filter(m => m.itemId === item.id).sort((a, b) => b.joinedAt - a.joinedAt);
  const plans = useMemo(() => [
    ...Object.entries(days).flatMap(([date, tasks]) => tasks.filter(t => resolvePlanWorkItem(tasks, t.id) === item.id).map(task => ({ date, task, archived: false }))),
    ...Object.entries(archived).flatMap(([date, day]) => day.tasks.filter(t => resolvePlanWorkItem(day.tasks, t.id) === item.id).map(task => ({ date, task, archived: true }))),
  ].sort((a, b) => b.date.localeCompare(a.date) || a.task.createdAt - b.task.createdAt), [days, archived, item.id]);
  const openPlan = (date: string, id: string, isArchived = false) => navigate(`/plans?date=${encodeURIComponent(date)}&task=${encodeURIComponent(id)}${isArchived ? "&archived=1" : ""}`);
  async function submitAction(e: React.FormEvent) {
    e.preventDefault(); if (saving) return; setError(""); setSaving(true);
    try {
      if (action === "carry") state.carryItem(item.id, target === "none" ? null : target);
      else { if (!planTitle.trim() || !planDate) return setError(c.required); await flushAllStorage(); usePlans.getState().addLinkedTask(planDate, null, planTitle.trim(), item.id); toast.success(c.planCreated); }
      setAction(null);
    } catch { setError(c.failed); } finally { setSaving(false); }
  }
  const mergedOriginal = item.mergedSnapshot?.item ?? item;
  if (item.mergedIntoId) return <aside className="flex min-h-0 w-full flex-col border-l border-border bg-background xl:w-[340px] xl:shrink-0" aria-label={c.details}><div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4"><span className="text-xs font-medium text-muted-foreground">{z.merged}</span><Button variant="ghost" size="icon-sm" aria-label={c.close} onClick={onClose}><X /></Button></div><div className="space-y-4 overflow-y-auto p-4"><h2 className="break-words text-lg font-semibold">{mergedOriginal.title}</h2><p className="text-sm">{z.mergedInto} · {state.items.find(value => value.id === item.mergedIntoId)?.title}</p><p className="text-xs leading-relaxed text-muted-foreground">{z.mergedReadOnly}</p><p className="text-xs text-muted-foreground">{c.status} · {c[mergedOriginal.status]}</p><p className="text-xs text-muted-foreground">{c.deadline} · {mergedOriginal.deadline ?? c.noDeadline}</p>{mergedOriginal.note && <p className="whitespace-pre-wrap break-words text-sm">{mergedOriginal.note}</p>}<h3 className="text-xs font-medium text-muted-foreground">{c.history} · {history.length}</h3>{history.map(value => <p key={value.id} className="text-xs text-muted-foreground">{state.iterations.find(iteration => iteration.id === value.iterationId)?.name} · {value.snapshot?.title ?? item.title}</p>)}</div></aside>;
  return <aside className="flex min-h-0 w-full flex-col border-l border-border bg-background xl:w-[340px] xl:shrink-0" aria-label={c.details}>
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4"><span className="text-xs font-medium text-muted-foreground">{c.details}</span><div className="flex gap-0.5"><Button variant="ghost" size="icon-sm" title={c.editItem} aria-label={c.editItem} onClick={onEdit}><Pencil /></Button><Button variant="ghost" size="icon-sm" title={c.close} aria-label={c.close} onClick={onClose}><X /></Button></div></div>
    <div className="flex-1 space-y-6 overflow-y-auto px-4 py-5">
      <div><div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground"><span>{hasZenSource ? z.source : c.local}</span><span>·</span><span className="truncate">{project?.name ?? area?.name ?? c.noProject}</span></div><h2 className="break-words text-lg leading-snug font-semibold">{item.title}</h2></div>
      <ZenSource itemId={item.id} />
      {!hasZenSource && <Button variant="outline" size="sm" className="w-full" onClick={() => setZenOpen(true)}>{z.bind}</Button>}
      <div className="grid gap-3">
        <div className="grid grid-cols-[68px_1fr] items-center gap-3"><span className="text-xs text-muted-foreground">{c.status}</span><ProjectSelect label={c.status} value={item.status} onChange={v => state.updateItem(item.id, { status: v as ItemRecord["status"] })} options={(["todo", "doing", "done", "cancelled"] as const).map(status => ({ value: status, label: c[status] }))} /></div>
        <div className="grid grid-cols-[68px_1fr] items-center gap-3"><span className="text-xs text-muted-foreground">{c.iteration}</span><button className="flex min-w-0 items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring outline-none" title={c.carry} onClick={() => { setTarget(item.activeIterationId ?? "none"); setAction("carry"); }}><span className="truncate">{iteration?.name ?? c.unplanned}</span><ArrowRightLeft className="size-3.5 shrink-0 text-muted-foreground" /></button></div>
        <div className="grid grid-cols-[68px_1fr] items-center gap-3"><label htmlFor={`deadline-${item.id}`} className="text-xs text-muted-foreground">{c.deadline}</label><Input id={`deadline-${item.id}`} type="date" value={item.deadline ?? ""} onChange={e => state.updateItem(item.id, { deadline: e.target.value || null })} /></div>
        {!item.deadline && iteration && <p className="pl-[80px] text-xs text-muted-foreground">{c.iterationDeadline} · {iteration.end}</p>}
        {deadline && deadline < todayStr() && item.status !== "done" && item.status !== "cancelled" && <p className="pl-[80px] text-xs text-amber-700 dark:text-amber-400">{deadlineLabel(deadline, c)}</p>}
      </div>
      {item.note && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{item.note}</p>}
      <div className="space-y-2"><div className="flex items-center justify-between"><h3 className="text-xs font-medium text-muted-foreground">{c.plans}<span className="ml-1.5 tabular-nums">{plans.length}</span></h3><Button variant="ghost" size="icon-sm" title={c.derive} aria-label={c.derive} onClick={() => { setPlanTitle(item.title); setPlanDate(todayStr()); setAction("plan"); }}><CalendarPlus /></Button></div>
        {!plans.length && <p className="py-1 text-xs text-muted-foreground">{c.noPlans}</p>}
        {plans.map(({ date, task, archived: isArchived }) => <button key={`${isArchived}-${date}-${task.id}`} onClick={() => openPlan(date, task.id, isArchived)} className="group flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring outline-none"><StatusMark status={task.done ? "done" : "todo"} className="mt-0.5 shrink-0" /><span className="min-w-0 flex-1"><span className="block truncate text-sm">{task.title}</span><span className="text-xs text-muted-foreground">{date}{task.start ? ` · ${task.start}` : ""}{isArchived ? ` · ${c.archivedPlan}` : ""}</span></span><ExternalLink className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" /></button>)}
        <Button variant="outline" size="sm" className="mt-1 w-full" onClick={() => { setPlanTitle(item.title); setPlanDate(todayStr()); setAction("plan"); }}><CalendarPlus />{c.derive}</Button>
      </div>
      {!!history.length && <div className="space-y-3"><h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><History className="size-3.5" />{c.history}</h3>{history.map(m => { const iterationName = state.iterations.find(i => i.id === m.iterationId)?.name ?? m.iterationId; return <div key={m.id} className="border-l-2 border-border pl-3"><div className="flex items-center justify-between gap-2 text-xs"><span className="truncate font-medium">{iterationName}</span><span className="shrink-0 text-muted-foreground">{m.leftAt === null ? c.current : c.carried}</span></div><p className="mt-1 text-[11px] text-muted-foreground tabular-nums">{new Date(m.joinedAt).toLocaleDateString()}{m.leftAt !== null && <> <ArrowRight className="inline size-3" /> {new Date(m.leftAt).toLocaleDateString()}</>}</p>{m.snapshot && <p className="mt-1 truncate text-xs text-muted-foreground" title={m.snapshot.title}>{c.membershipSnapshot} · {c[m.snapshot.status]}{m.snapshot.deadline ? ` · ${m.snapshot.deadline}` : ""}</p>}</div>; })}</div>}
      <div className="flex flex-wrap gap-1 border-t border-border pt-3"><Button variant="ghost" size="sm" onClick={onReminder}><Bell />{c.reminders}{item.reminder ? " ·" : ""}</Button><Button variant="ghost" size="sm" onClick={() => { setTarget(item.activeIterationId ?? "none"); setAction("carry"); }}><ArrowRightLeft />{c.carry}</Button></div>
    </div>
    {zenOpen && <ZenBinding key={item.id} itemId={item.id} onClose={() => setZenOpen(false)} />}
    <Dialog open={action !== null} onOpenChange={open => { if (!open) setAction(null); }}><DialogContent aria-describedby={undefined}><form className="grid gap-4" onSubmit={submitAction}><DialogHeader><DialogTitle>{action === "carry" ? c.carry : c.derive}</DialogTitle></DialogHeader>{action === "carry" ? <Field label={c.carryTarget}><ProjectSelect label={c.carryTarget} value={target} onChange={setTarget} options={[{ value: "none", label: c.unplanned }, ...state.iterations.map(i => ({ value: i.id, label: `${i.name} · ${i.start} – ${i.end}` }))]} /></Field> : <><Field label={c.planTitle}><Input autoFocus required value={planTitle} onChange={e => setPlanTitle(e.target.value)} aria-label={c.planTitle} /></Field><Field label={c.planDate}><Input required type="date" value={planDate} onChange={e => setPlanDate(e.target.value)} aria-label={c.planDate} /></Field></>}{error && <p role="alert" className="text-xs text-destructive">{error}</p>}<DialogFooter><Button type="button" variant="ghost" onClick={() => setAction(null)}>{c.cancel}</Button><Button type="submit" disabled={saving}>{c.save}</Button></DialogFooter></form></DialogContent></Dialog>
  </aside>;
}
