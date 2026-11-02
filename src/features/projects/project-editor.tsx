import { useMemo, useState } from "react";
import { GripVertical, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { usePointerDrag } from "@/features/plans/use-pointer-drag";
import { useProjectsCopy } from "./copy";
import { useSettings } from "@/stores/settings";
import { ItemDetails, StatusMark, deadlineLabel, itemDeadline } from "./details";
import { ItemEditor, type ItemRecord, type ProjectRecord } from "./forms";
import { useProjects } from "./store";
import { IconPicker } from "./icon-picker";import { todayStr } from "@/features/plans/types";

/**
 * 项目编辑弹框：名称、图标、计划表一次改完，写库即时生效（和详情面板一致），
 * 所以底部只有「关闭」——没有草稿就不会出现「改了没保存」。
 */
export function ProjectEditor({ project, onClose, onDelete }: { project: ProjectRecord; onClose: () => void; onDelete: () => void }) {
  const c = useProjectsCopy(), state = useProjects();
  const en = useSettings((store) => store.lang) === "en";
  const live = state.projects.find(entry => entry.id === project.id) ?? project;
  const [name, setName] = useState(live.name);
  const [nameError, setNameError] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id?: string; parentId?: string } | null>(null);
  const plans = useMemo(() => state.items.filter(item => item.projectId === live.id), [state.items, live.id]);
  const pickedItem = plans.find(item => item.id === picked);
  const depthOf = (item: ItemRecord) => { let level = 0, cursor = item.parentId ? plans.find(entry => entry.id === item.parentId) : undefined; while (cursor && level < 8) { level++; cursor = cursor.parentId ? plans.find(entry => entry.id === cursor!.parentId) : undefined; } return level; };
  const commitName = () => {
    const value = name.trim();
    if (!value) { setNameError(c.required); return; }
    if (value === live.name) { setNameError(""); return; }
    try { state.updateProject(live.id, { name: value }); setNameError(""); }
    // 不退回输入框：让用户看着自己刚打的名字改，比清空更好纠正
    catch (cause) { setNameError(String(cause).includes("already exists") ? c.nameTaken : c.failed); }
  };
  function movePlan(id: string, target: string) {
    if (id === target) return;
    const ids = plans.map(item => item.id), from = ids.indexOf(id), to = ids.indexOf(target);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    try { state.reorderItems(ids); } catch { /* 排序失败不该关掉弹框 */ }
  }
  // WebView2 开着原生拖放时 HTML5 拖拽会被接管，页面内排序必须走 pointer。
  const planDrag = usePointerDrag<string>({
    hitTest: element => element?.closest<HTMLElement>("[data-project-plan]")?.dataset.projectPlan ?? null,
    onDrop: movePlan,
  });
  const today = todayStr();
  return <>
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="flex h-[min(88vh,760px)] w-full max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl" aria-describedby={undefined}>
        <DialogHeader className="shrink-0 border-b border-border px-5 py-3"><DialogTitle>{c.editProject}</DialogTitle></DialogHeader>
        <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-h-0 space-y-5 overflow-y-auto p-5">
            {/* 名称与图标是同一个「这是什么项目」的决定，放一张卡里；计划另起一块 */}
            <div className="space-y-3 rounded-lg border border-border p-4">
              <label className="flex items-center gap-3 text-xs font-medium text-muted-foreground">
                <span className="w-12 shrink-0">{c.name}</span>
                <Input autoFocus value={name} maxLength={300} aria-label={c.name} aria-invalid={Boolean(nameError)}
                  onChange={event => { setName(event.target.value); setNameError(""); }}
                  onBlur={commitName}
                  onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commitName(); } }}
                  className={cn("h-8", nameError && "border-destructive")} />
              </label>
              {nameError ? <p role="alert" className="pl-[3.75rem] text-[11px] leading-4 text-destructive">{nameError}</p> : null}
              <div className="flex items-start gap-3">
                <span className="w-12 shrink-0 pt-1.5 text-xs font-medium text-muted-foreground">{c.icon}</span>
                <div className="min-w-0 flex-1">
                  <IconPicker
                    value={live.icon}
                    color={live.color}
                    en={en}
                    onPick={(icon, color) => state.updateProject(live.id, { icon, ...(color != null ? { color } : {}) })}
                  />
                  <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">{c.iconColorHint}</p>
                </div>
              </div>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between"><h3 className="text-xs font-medium text-muted-foreground">{c.projectPlans}<span className="ml-1.5 tabular-nums">{plans.length}</span></h3><Button variant="ghost" size="icon-sm" title={c.newItem} aria-label={c.newItem} onClick={() => setEditing({})}><Plus /></Button></div>
              {!plans.length && <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{c.projectPlansEmpty}</p>}
              <div role="list" className="space-y-0.5">
                {plans.map(item => {
                  const deadline = itemDeadline(item, state.iterations), closed = item.status === "done" || item.status === "cancelled";
                  return <div key={item.id} role="listitem" data-project-plan={item.id} onPointerDown={event => planDrag.start(event, item.id)}
                    style={{ paddingLeft: `${4 + depthOf(item) * 14}px` }}
                    className={cn("group flex min-w-0 items-center gap-1.5 rounded-md py-1 pr-1.5 hover:bg-muted/60", picked === item.id && "bg-accent/70", planDrag.over === item.id && planDrag.dragging !== item.id && "ring-1 ring-primary/60", planDrag.dragging === item.id && "opacity-40")}>
                    <GripVertical className="size-3.5 shrink-0 cursor-grab text-muted-foreground/50" aria-hidden />
                    <button type="button" disabled={Boolean(item.mergedIntoId)} aria-label={`${closed ? c.restoreItem : c.completed} · ${item.title}`} title={closed ? c.restoreItem : c.completed} onClick={() => state.updateItem(item.id, { status: closed ? "todo" : "done" })}
                      className="flex size-5 shrink-0 items-center justify-center rounded outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">
                      <StatusMark status={item.status} />
                    </button>
                    <button type="button" aria-pressed={picked === item.id} onClick={() => setPicked(item.id)} className={cn("min-w-0 flex-1 truncate rounded px-0.5 py-0.5 text-left text-[13px]", closed && "text-muted-foreground", item.status === "done" && "line-through decoration-muted-foreground/40")}>{item.title}</button>
                    {deadline && <span className={cn("shrink-0 text-[11px] tabular-nums", deadline < today && !closed ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>{deadlineLabel(deadline, c)}</span>}
                    <Button variant="ghost" size="icon-xs" className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" title={c.newSubPlan} aria-label={`${c.newSubPlan} · ${item.title}`} onClick={() => setEditing({ parentId: item.id })}><Plus /></Button>
                  </div>;
                })}
              </div>
            </div>
          </div>
          <div className="min-h-0 border-t border-border md:border-t-0 md:border-l">
            {pickedItem ? <ItemDetails key={pickedItem.id} item={pickedItem} onClose={() => setPicked(null)} onEdit={() => setEditing({ id: pickedItem.id })} />
              : <p className="p-4 text-xs leading-relaxed text-muted-foreground">{c.planDetailHint}</p>}
          </div>
        </div>
        <DialogFooter className="mx-0 mb-0 shrink-0 rounded-none border-border px-5 py-3"><Button type="button" variant="ghost" className="mr-auto text-destructive hover:text-destructive" onClick={onDelete}>{c.deleteProject}</Button><Button type="button" onClick={onClose}>{c.closeEditor}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    {editing && <ItemEditor key={editing.id ?? "new"} item={state.items.find(entry => entry.id === editing.id)} projectId={live.id} parentId={editing.parentId} onClose={() => setEditing(null)} onSaved={id => { setEditing(null); setPicked(id); }} />}
  </>;
}
