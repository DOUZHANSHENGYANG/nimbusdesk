import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { todayStr } from "@/features/plans/types";
import { useProjects } from "./store";
import { iterationRange } from "./core";
import { useProjectsCopy, useProjectWeekdays } from "./copy";

type State = ReturnType<typeof useProjects.getState>;
export type ProjectRecord = State["projects"][number];
export type ItemRecord = State["items"][number];
export type IterationRecord = State["iterations"][number];
export type ReminderRecord = State["reminderRule"];

export function ProjectSelect({ label, value, onChange, options, className = "", disabled = false }: { label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; className?: string; disabled?: boolean }) {
  return <Select value={value} onValueChange={onChange} disabled={disabled}><SelectTrigger aria-label={label} className={`w-full min-w-0 ${className}`}><SelectValue /></SelectTrigger><SelectContent position="popper">{options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select>;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-muted-foreground"><span>{label}</span>{children}</label>;
}
function EditorDialog({ title, onClose, onSubmit, children, error }: { title: string; onClose: () => void; onSubmit: (event: FormEvent) => void; children: ReactNode; error: string }) {
  const c = useProjectsCopy();
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="sm:max-w-md" aria-describedby={undefined}><form onSubmit={onSubmit} className="grid gap-4"><DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>{children}{error && <p role="alert" className="text-xs text-destructive">{error}</p>}<DialogFooter><Button type="button" variant="ghost" onClick={onClose}>{c.cancel}</Button><Button type="submit">{c.save}</Button></DialogFooter></form></DialogContent></Dialog>;
}
export function ProjectEditor({ project, areaId, onClose, onSaved }: { project?: ProjectRecord; areaId?: string | null; onClose: () => void; onSaved: (id: string) => void }) {
  const c = useProjectsCopy(), state = useProjects();
  const [name, setName] = useState(project?.name ?? ""), [area, setArea] = useState(project?.areaId ?? areaId ?? "none"), [note, setNote] = useState(project?.note ?? ""), [status, setStatus] = useState<ProjectRecord["status"]>(project?.status ?? "active"), [error, setError] = useState("");
  return <EditorDialog title={project ? c.editProject : c.newProject} onClose={onClose} error={error} onSubmit={e => { e.preventDefault(); if (!name.trim()) return setError(c.required); try { const input = { name: name.trim(), areaId: area === "none" ? null : area, note, status }; const id = project ? (state.updateProject(project.id, input), project.id) : state.addProject(input); onSaved(id); } catch { setError(c.failed); } }}>
    <Field label={c.name}><Input autoFocus required maxLength={300} value={name} onChange={e => setName(e.target.value)} aria-label={c.name} /></Field>
    <Field label={c.area}><ProjectSelect label={c.area} value={area} onChange={setArea} options={[{ value: "none", label: c.unclassified }, ...state.areas.map(a => ({ value: a.id, label: a.name }))]} /></Field>
    {project && <Field label={c.status}><ProjectSelect label={c.status} value={status} onChange={v => setStatus(v as ProjectRecord["status"])} options={[{ value: "active", label: c.active }, { value: "archived", label: c.archived }]} /></Field>}
    <Field label={c.note}><Textarea value={note} onChange={e => setNote(e.target.value)} rows={3} aria-label={c.note} /></Field>
  </EditorDialog>;
}
export function IterationEditor({ iteration, onClose, onSaved }: { iteration?: IterationRecord; onClose: () => void; onSaved: (id: string) => void }) {
  const c = useProjectsCopy(), state = useProjects();
  const initialRange = iterationRange(todayStr(), 2);
  const [name, setName] = useState(iteration?.name ?? ""), [start, setStart] = useState(iteration?.start ?? initialRange.start), [end, setEnd] = useState(iteration?.end ?? initialRange.end), [duration, setDuration] = useState(iteration ? "custom" : "14"), [error, setError] = useState("");
  const changeStart = (value: string) => { setStart(value); setDuration("custom"); };
  return <EditorDialog title={iteration ? c.editIteration : c.newIteration} onClose={onClose} error={error} onSubmit={e => { e.preventDefault(); if (!name.trim()) return setError(c.required); if (!start || !end || end < start) return setError(c.invalidRange); try { const input = { name: name.trim(), start, end }; const id = iteration ? (state.updateIteration(iteration.id, input), iteration.id) : state.addIteration(input); onSaved(id); } catch { setError(c.failed); } }}>
    <Field label={c.name}><Input autoFocus required maxLength={300} value={name} onChange={e => setName(e.target.value)} aria-label={c.name} /></Field>
    <div className="flex gap-1" role="group" aria-label={c.iteration}>{[{ value: "14", label: c.twoWeeks }, { value: "21", label: c.threeWeeks }, { value: "custom", label: c.custom }].map(o => <Button key={o.value} type="button" variant={duration === o.value ? "secondary" : "ghost"} aria-pressed={duration === o.value} onClick={() => { setDuration(o.value); if (o.value !== "custom") { const range = iterationRange(start || todayStr(), Number(o.value) / 7); setStart(range.start); setEnd(range.end); } }}>{o.label}</Button>)}</div>
    <div className="grid grid-cols-2 gap-3"><Field label={c.start}><Input required type="date" value={start} onChange={e => changeStart(e.target.value)} aria-label={c.start} /></Field><Field label={c.end}><Input required type="date" min={start} value={end} onChange={e => { setDuration("custom"); setEnd(e.target.value); }} aria-label={c.end} /></Field></div>
  </EditorDialog>;
}
export function ItemEditor({ item, projectId, areaId, iterationId, onClose, onSaved }: { item?: ItemRecord; projectId?: string | null; areaId?: string | null; iterationId?: string | null; onClose: () => void; onSaved: (id: string) => void }) {
  const c = useProjectsCopy(), state = useProjects();
  const [title, setTitle] = useState(item?.title ?? ""), [project, setProject] = useState(item?.projectId ?? projectId ?? "none"), [area, setArea] = useState(item?.areaId ?? areaId ?? "none"), [iteration, setIteration] = useState(item?.activeIterationId ?? iterationId ?? "none"), [deadline, setDeadline] = useState(item?.deadline ?? ""), [note, setNote] = useState(item?.note ?? ""), [error, setError] = useState("");
  return <EditorDialog title={item ? c.editItem : c.newItem} onClose={onClose} error={error} onSubmit={e => { e.preventDefault(); if (!title.trim()) return setError(c.required); try { const input = { title: title.trim(), projectId: project === "none" ? null : project, areaId: area === "none" ? null : area, deadline: deadline || null, note }; const target = iteration === "none" ? null : iteration; let id: string; if (item) { state.updateItem(item.id, input); if (target !== item.activeIterationId) state.carryItem(item.id, target); id = item.id; } else id = state.addItem({ ...input, activeIterationId: target }); onSaved(id); } catch { setError(c.failed); } }}>
    <Field label={c.itemTitle}><Input autoFocus required maxLength={1000} value={title} onChange={e => setTitle(e.target.value)} aria-label={c.itemTitle} /></Field>
    <div className="grid grid-cols-2 gap-3"><Field label={c.project}><ProjectSelect label={c.project} value={project} onChange={setProject} options={[{ value: "none", label: c.noProject }, ...state.projects.filter(p => p.status === "active" || p.id === project).map(p => ({ value: p.id, label: p.name }))]} /></Field><Field label={c.area}><ProjectSelect label={c.area} disabled={project !== "none"} value={project === "none" ? area : state.projects.find(p => p.id === project)?.areaId ?? "none"} onChange={setArea} options={[{ value: "none", label: c.unclassified }, ...state.areas.map(a => ({ value: a.id, label: a.name }))]} /></Field></div>
    <div className="grid grid-cols-2 gap-3"><Field label={c.iteration}><ProjectSelect label={c.iteration} value={iteration} onChange={setIteration} options={[{ value: "none", label: c.unplanned }, ...state.iterations.map(i => ({ value: i.id, label: i.name }))]} /></Field><Field label={c.deadline}><Input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} aria-label={c.deadline} /></Field></div>
    <Field label={c.note}><Textarea value={note} onChange={e => setNote(e.target.value)} rows={4} aria-label={c.note} /></Field>
  </EditorDialog>;
}
export function ReminderEditor({ title, rule, inherited, allowInherit = false, onClose, onSave }: { title: string; rule?: ReminderRecord | null; inherited: ReminderRecord; allowInherit?: boolean; onClose: () => void; onSave: (rule: ReminderRecord | null) => void }) {
  const c = useProjectsCopy(), weekdayLabels = useProjectWeekdays();
  const [inherit, setInherit] = useState(allowInherit && !rule), [draft, setDraft] = useState<ReminderRecord>(() => ({ ...(rule ?? inherited), weekdays: [...(rule ?? inherited).weekdays] })), [times, setTimes] = useState((rule ?? inherited).times.join(", ")), [error, setError] = useState("");
  return <EditorDialog title={title} onClose={onClose} error={error} onSubmit={e => { e.preventDefault(); if (inherit) { onSave(null); onClose(); return; } const slots = [...new Set(times.split(/[,，\s]+/).filter(Boolean))].sort(); if (!slots.length || slots.some(t => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) return setError(c.timeInvalid); try { new Intl.DateTimeFormat("en", { timeZone: draft.timezone }).format(); } catch { return setError(c.timezoneInvalid); } try { onSave({ ...draft, times: slots }); onClose(); toast.success(c.saved); } catch { setError(c.failed); } }}>
    {allowInherit && <ProjectSelect label={c.reminders} value={inherit ? "inherit" : "override"} onChange={v => setInherit(v === "inherit")} options={[{ value: "inherit", label: c.inherit }, { value: "override", label: c.override }]} />}
    <fieldset disabled={inherit} className="grid gap-4 disabled:opacity-45"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} className="size-4 accent-primary" />{c.enabled}</label>
      <Field label={c.times}><Input value={times} onChange={e => setTimes(e.target.value)} placeholder="09:00, 16:50" aria-label={c.times} /></Field>
      <div className="grid grid-cols-2 gap-3"><Field label={c.advance}><Input type="number" min={0} max={365} required value={draft.advanceDays} onChange={e => setDraft({ ...draft, advanceDays: Number(e.target.value) })} aria-label={c.advance} /></Field><Field label={c.timezone}><Input required value={draft.timezone} onChange={e => setDraft({ ...draft, timezone: e.target.value })} aria-label={c.timezone} /></Field></div>
      <Field label={c.weekdays}><div className="flex gap-1">{weekdayLabels.map((day, index) => <Button key={index} type="button" size="sm" className="flex-1 px-0" variant={draft.weekdays.includes(index) ? "secondary" : "ghost"} aria-pressed={draft.weekdays.includes(index)} onClick={() => setDraft({ ...draft, weekdays: draft.weekdays.includes(index) ? draft.weekdays.filter(v => v !== index) : [...draft.weekdays, index].sort() })}>{day}</Button>)}</div></Field>
      <Field label={c.nonWorkingDay}><ProjectSelect label={c.nonWorkingDay} value={draft.nonWorkingDay} onChange={v => setDraft({ ...draft, nonWorkingDay: v as ReminderRecord["nonWorkingDay"] })} options={[{ value: "same", label: c.sameDay }, { value: "previous", label: c.previousDay }]} /></Field>
    </fieldset><p className="text-xs text-muted-foreground">{c.reminderRuntime}</p>
  </EditorDialog>;
}
