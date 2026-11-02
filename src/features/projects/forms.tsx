import { useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { todayStr } from "@/features/plans/types";
import { useProjects } from "./store";
import { iterationRange, validDate } from "./core";
import { useProjectsCopy } from "./copy";

type State = ReturnType<typeof useProjects.getState>;
export type ProjectRecord = State["projects"][number];
export type ItemRecord = State["items"][number];
export type IterationRecord = State["iterations"][number];

export function ProjectSelect({ label, value, onChange, options, className = "", disabled = false, size = "default" }: { label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; className?: string; disabled?: boolean; size?: "sm" | "default" }) {
  return <Select value={value} onValueChange={onChange} disabled={disabled}><SelectTrigger size={size} aria-label={label} className={`w-full min-w-0 ${className}`}><SelectValue /></SelectTrigger><SelectContent position="popper">{options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select>;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-muted-foreground"><span>{label}</span>{children}</label>;
}
/** 单行输入里回车即保存：只挂在真正「敲完就走」的输入上，而不是整个表单。 */
export function submitOnEnter(event: ReactKeyboardEvent<HTMLInputElement>) {
  if (event.key !== "Enter" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.repeat) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}
function EditorDialog({ title, onClose, onSubmit, children, error, actions }: { title: string; onClose: () => void; onSubmit: (event: FormEvent) => void; children: ReactNode; error: string; actions?: ReactNode }) {
  const c = useProjectsCopy();
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="sm:max-w-md" aria-describedby={undefined}><form onSubmit={onSubmit} className="grid gap-4"><DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>{children}{error && <p role="alert" className="text-xs text-destructive">{error}</p>}<DialogFooter>{actions && <div className="mr-auto">{actions}</div>}<Button type="button" variant="ghost" onClick={onClose}>{c.cancel}</Button><Button type="submit">{c.save}</Button></DialogFooter></form></DialogContent></Dialog>;
}
export function IterationEditor({ iteration, onClose, onSaved }: { iteration?: IterationRecord; onClose: () => void; onSaved: (id: string) => void }) {
  const c = useProjectsCopy(), state = useProjects();
  const initialRange = iterationRange(todayStr(), 2);
  const [name, setName] = useState(iteration?.name ?? ""), [start, setStart] = useState(iteration?.start ?? initialRange.start), [end, setEnd] = useState(iteration?.end ?? initialRange.end), [duration, setDuration] = useState(iteration ? "custom" : "14"), [error, setError] = useState("");
  const changeStart = (value: string) => { setStart(value); setDuration("custom"); };
  return <EditorDialog title={iteration ? c.editIteration : c.newIteration} onClose={onClose} error={error} onSubmit={e => { e.preventDefault(); if (!name.trim()) return setError(c.required); if (!start || !end || end < start) return setError(c.invalidRange); try { const input = { name: name.trim(), start, end }; const id = iteration ? (state.updateIteration(iteration.id, input), iteration.id) : state.addIteration(input); onSaved(id); } catch { setError(c.failed); } }}>
    <Field label={c.name}><Input autoFocus required maxLength={300} value={name} onChange={e => setName(e.target.value)} onKeyDown={submitOnEnter} aria-label={c.name} /></Field>
    <div className="flex gap-1" role="group" aria-label={c.iteration}>{[{ value: "14", label: c.twoWeeks }, { value: "21", label: c.threeWeeks }, { value: "custom", label: c.custom }].map(o => <Button key={o.value} type="button" variant={duration === o.value ? "default" : "ghost"} aria-pressed={duration === o.value} onClick={() => { setDuration(o.value); if (o.value !== "custom") { const range = iterationRange(start || todayStr(), Number(o.value) / 7); setStart(range.start); setEnd(range.end); } }}>{o.label}</Button>)}</div>
    <div className="grid grid-cols-2 gap-3"><Field label={c.start}><Input required type="date" value={start} onChange={e => changeStart(e.target.value)} aria-label={c.start} /></Field><Field label={c.end}><Input required type="date" min={start} value={end} onChange={e => { setDuration("custom"); setEnd(e.target.value); }} aria-label={c.end} /></Field></div>
  </EditorDialog>;
}
export function ItemEditor({ item, projectId, parentId, iterationId, onClose, onSaved }: { item?: ItemRecord; projectId?: string | null; parentId?: string | null; iterationId?: string | null; onClose: () => void; onSaved: (id: string) => void }) {
  const c = useProjectsCopy(), state = useProjects();
  const [title, setTitle] = useState(item?.title ?? ""), [iteration, setIteration] = useState(item?.activeIterationId ?? iterationId ?? "none"), [deadline, setDeadline] = useState(item?.deadline ?? ""), [note, setNote] = useState(item?.note ?? ""), [weight, setWeight] = useState(String(item?.weight ?? 1)), [percent, setPercent] = useState(item?.percent == null ? "" : String(item.percent)), [start, setStart] = useState(item?.startDate ?? ""), [end, setEnd] = useState(item?.endDate ?? ""), [error, setError] = useState("");
  // 计划只编辑「自己」的字段：项目由当前页面决定，父计划不再由表单指定。
  // 截止 / 开始 / 结束都可以留空。
  return <EditorDialog title={item ? c.editItem : c.newItem} onClose={onClose} error={error} onSubmit={e => {
    e.preventDefault();
    if (!title.trim()) return setError(c.required);
    if ((start && !validDate(start)) || (end && !validDate(end))) return setError(c.dateInvalid);
    if (start && end && start > end) return setError(c.invalidRange);
    const weightValue = weight.trim() === "" ? 1 : Number(weight);
    if (!Number.isFinite(weightValue) || weightValue <= 0 || weightValue > 1000) return setError(c.weightHint);
    const percentValue = percent.trim() === "" ? null : Number(percent);
    if (percentValue !== null && (!Number.isFinite(percentValue) || percentValue < 0 || percentValue > 100)) return setError(c.percentAuto);
    try { const input = { title: title.trim(), deadline: deadline || null, note, weight: weightValue, percent: percentValue, startDate: start || null, endDate: end || null }; const target = iteration === "none" ? null : iteration; let id: string; if (item) { state.updateItem(item.id, input); if (target !== item.activeIterationId) state.carryItem(item.id, target); id = item.id; } else id = state.addItem({ ...input, projectId: projectId ?? null, parentId: parentId ?? null, activeIterationId: target }); onSaved(id); } catch { setError(c.failed); } }}>
    <Field label={c.itemTitle}><Input autoFocus required maxLength={1000} value={title} onChange={e => setTitle(e.target.value)} onKeyDown={submitOnEnter} aria-label={c.itemTitle} /></Field>
    <div className="grid grid-cols-2 gap-3"><Field label={c.iteration}><ProjectSelect label={c.iteration} value={iteration} onChange={setIteration} options={[{ value: "none", label: c.unplanned }, ...state.iterations.map(i => ({ value: i.id, label: i.name }))]} /></Field><Field label={c.deadline}><Input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} aria-label={c.deadline} /></Field></div>
    <div className="grid grid-cols-2 gap-3"><Field label={c.weight}><Input type="number" min={0.1} max={1000} step={0.1} value={weight} placeholder={c.weightHint} onChange={e => setWeight(e.target.value)} aria-label={c.weight} /></Field><Field label={c.percent}><Input type="number" min={0} max={100} value={percent} placeholder={c.percentAuto} onChange={e => setPercent(e.target.value)} aria-label={c.percent} /></Field></div>
    <div className="grid grid-cols-2 gap-3"><Field label={c.start}><Input type="date" value={start} onChange={e => setStart(e.target.value)} aria-label={c.start} /></Field><Field label={c.end}><Input type="date" min={start} value={end} onChange={e => setEnd(e.target.value)} aria-label={c.end} /></Field></div>
    <Field label={c.note}><Textarea value={note} onChange={e => setNote(e.target.value)} rows={4} aria-label={c.note} /></Field>
  </EditorDialog>;
}
