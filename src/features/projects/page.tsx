import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Bell, CalendarDays, ChevronRight, Folder, FolderKanban, Layers3, LayoutDashboard, ListTodo, LoaderCircle, Pencil, Plus, Search, SquareKanban, Trash2, X, ArrowRightLeft } from "lucide-react";
import { toast } from "sonner";
import { ProjectViewsBar } from "./views-bar";
import { ProjectsBoard } from "./board";
import { ProjectsOverview } from "./overview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useModal } from "@/components/shell/modal-host";
import { useStorageHealth } from "@/stores/storage-health";
import { cn } from "@/lib/utils";
import { todayStr } from "@/features/plans/types";
import { usePlans, usePlansArchive } from "@/features/plans/store";
import { useProjects } from "./store";
import { resolvePlanWorkItem } from "./core";
import { ProjectEditor, IterationEditor, ItemEditor, ReminderEditor, ProjectSelect, type ItemRecord } from "./forms";
import { ItemDetails, StatusMark, itemDeadline, deadlineLabel } from "./details";
import { ProjectFiles } from "./files";
import { useProjectsCopy } from "./copy";
import { ZenPanel, ZenConnectionsButton } from "./zentao-panel";
import { useZentao } from "./zentao-store";
import { useZenCopy } from "./zentao-copy";
import "./projects.css";

type Scope = { kind: "all" | "unclassified" | "unassigned" } | { kind: "area" | "project"; id: string };
type Editor = { kind: "project" | "iteration" | "item"; id?: string } | { kind: "reminder"; projectId?: string; itemId?: string } | null;
type WorkTab = "overview" | "tasks" | "board" | "files";

const projectStores = [useProjects, usePlans, usePlansArchive, useZentao] as const;
const projectStorageKeys = ["projects", "plans", "plans-archive", "zentao"];

export function ProjectsPage() {
  const c = useProjectsCopy();
  const [hydrated, setHydrated] = useState(() => projectStores.every(store => store.persist.hasHydrated()));
  const readFailed = useStorageHealth(s => s.problem === "unavailable" && projectStorageKeys.includes(s.key ?? ""));
  const [failed, setFailed] = useState(readFailed);
  useEffect(() => {
    const check = () => setHydrated(projectStores.every(store => store.persist.hasHydrated()));
    const off = projectStores.flatMap(store => [store.persist.onHydrate(() => setHydrated(false)), store.persist.onFinishHydration(check)]);
    check();
    return () => off.forEach(unsubscribe => unsubscribe());
  }, []);
  useEffect(() => { if (readFailed) setFailed(true); }, [readFailed]);
  if (failed || readFailed) return <div className="flex h-full items-center justify-center p-6"><div role="alert" className="max-w-sm text-center"><p className="text-sm font-medium">{c.readFailed}</p><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{c.readFailedHint}</p></div></div>;
  if (!hydrated) return <div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />{c.loading}</div>;
  return <ProjectsWorkspace />;
}

function ProjectsWorkspace() {
  const c = useProjectsCopy(), z = useZenCopy(), state = useProjects(), modal = useModal();
  const [zenOpen, setZenOpen] = useState(false);
  const planDays = usePlans(s => s.days), archivedDays = usePlansArchive(s => s.days);
  const planCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tasks of [...Object.values(planDays), ...Object.values(archivedDays).map(day => day.tasks)]) {
      for (const task of tasks) { const itemId = resolvePlanWorkItem(tasks, task.id); if (itemId) counts.set(itemId, (counts.get(itemId) ?? 0) + 1); }
    }
    return counts;
  }, [planDays, archivedDays]);
  const [scope, setScope] = useState<Scope>({ kind: "all" }), [iterationFilter, setIterationFilter] = useState("current"), [statusFilter, setStatusFilter] = useState("open"), [search, setSearch] = useState(""), [selectedId, setSelectedId] = useState<string | null>(null), [tab, setTab] = useState<WorkTab>("overview"), [editor, setEditor] = useState<Editor>(null), [showArchived, setShowArchived] = useState(false);
  const query = useDeferredValue(search.trim().toLocaleLowerCase()), today = todayStr();
  const iterations = useMemo(() => [...state.iterations].sort((a, b) => b.start.localeCompare(a.start) || b.createdAt - a.createdAt), [state.iterations]);
  const currentIteration = iterations.find(i => i.start <= today && i.end >= today);
  const filteredIterationId = iterationFilter === "current" ? currentIteration?.id ?? null : iterationFilter === "all" || iterationFilter === "none" ? null : iterationFilter;
  const selectedProject = scope.kind === "project" ? state.projects.find(p => p.id === scope.id) : undefined;
  const selectedArea = scope.kind === "area" ? state.areas.find(a => a.id === scope.id) : undefined;
  const selectedIteration = iterations.find(i => i.id === filteredIterationId);
  // 单一真相：tab 只有落在「有对应面板」的值上，才当成当前页。文件页没有选中项目时退回任务列表，
  // 这样任何 setTab 写错值都不会出现「切过去一片空白」。
  const activeTab: WorkTab = tab === "overview" ? "overview" : tab === "board" ? "board" : tab === "files" && selectedProject ? "files" : "tasks";
  // activeTab 到 "files" 时一定选着项目（见上），这里再算一次只为让类型也跟着收窄。
  const filesProject = activeTab === "files" ? selectedProject : undefined;
  const effectiveArea = (item: ItemRecord) => item.areaId ?? state.projects.find(p => p.id === item.projectId)?.areaId ?? null;
  const historicalItem = (item: ItemRecord): ItemRecord => {
    const membership = filteredIterationId ? state.memberships.find(m => m.itemId === item.id && m.iterationId === filteredIterationId && m.leftAt !== null) : undefined;
    return membership?.snapshot ? { ...item, ...membership.snapshot, activeIterationId: filteredIterationId } : item;
  };
  // 一份筛选谓词，两处消费：列表与看板要状态和搜索，总览只要范围与迭代——
  // 总览展示的就是状态分布，先按状态筛再统计会自相矛盾。
  function itemMatches(item: ItemRecord, withStatus: boolean, withQuery: boolean): boolean {
    const project = state.projects.find(p => p.id === item.projectId), areaId = item.areaId ?? project?.areaId ?? null, shown = historicalItem(item);
    if (scope.kind === "project" && item.projectId !== scope.id) return false;
    if (scope.kind === "area" && areaId !== scope.id) return false;
    if (scope.kind === "unclassified" && areaId !== null) return false;
    if (scope.kind === "unassigned" && item.projectId !== null) return false;
    if (!showArchived && project?.status === "archived" && scope.kind !== "project") return false;
    if (iterationFilter !== "all") {
      if (iterationFilter === "none" || (iterationFilter === "current" && !filteredIterationId)) { if (item.activeIterationId !== null) return false; }
      else if (!state.memberships.some(m => m.itemId === item.id && m.iterationId === filteredIterationId) && item.activeIterationId !== filteredIterationId) return false;
    }
    if (withStatus) {
      if (statusFilter === "open" && (shown.status === "done" || shown.status === "cancelled")) return false;
      if (statusFilter !== "open" && statusFilter !== "all" && shown.status !== statusFilter) return false;
    }
    return !withQuery || !query || [shown.title, item.title, item.note, project?.name, state.areas.find(a => a.id === areaId)?.name].some(value => value?.toLocaleLowerCase().includes(query));
  }
  const filtered = useMemo(() => state.items.filter(item => itemMatches(item, true, true)).sort((a, b) => {
    const aShown = historicalItem(a), bShown = historicalItem(b), aClosed = aShown.status === "done" || aShown.status === "cancelled", bClosed = bShown.status === "done" || bShown.status === "cancelled";
    return Number(aClosed) - Number(bClosed) || (itemDeadline(aShown, state.iterations) ?? "9999").localeCompare(itemDeadline(bShown, state.iterations) ?? "9999") || a.createdAt - b.createdAt;
  }), [state.items, state.projects, state.areas, state.memberships, state.iterations, scope, iterationFilter, filteredIterationId, statusFilter, query, showArchived]);
  // 总览那一批：同样的范围与迭代，但不吃状态与搜索，且套上历史迭代快照（口径与列表一致）。
  const overviewItems = useMemo(() => state.items.filter(item => itemMatches(item, false, false)).map(historicalItem), [state.items, state.projects, state.areas, state.memberships, state.iterations, scope, iterationFilter, filteredIterationId, statusFilter, query, showArchived]);
  const visibleItemIds = new Set(filtered.map(item => item.id));
  const linkedItemIds = new Set(state.remoteLinks.map(link => link.itemId));
  const hiddenUnplannedSources = state.items.filter(item => linkedItemIds.has(item.id) && !item.mergedIntoId && item.activeIterationId === null && !visibleItemIds.has(item.id)).length;
  const carriedItemIds = new Set(filtered.filter(item => filteredIterationId && item.activeIterationId !== filteredIterationId).map(item => item.id));
  // 看板与列表同一批卡片：套过历史迭代快照，顺序沿用列表的排序。
  const boardItems = filtered.map(historicalItem);
  const selectedItem = filtered.find(item => item.id === selectedId);
  function closeDetails() {
    const id = selectedId;
    setSelectedId(null);
    if (id) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-work-item="${CSS.escape(id)}"] button[aria-pressed]`)?.focus());
  }
  useEffect(() => { if (selectedId && !filtered.some(item => item.id === selectedId)) setSelectedId(null); }, [filtered, selectedId]);
  useEffect(() => {
    if (!selectedId || editor) return;
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.querySelector('[role="dialog"], [role="listbox"]')) { event.preventDefault(); closeDetails(); } };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [selectedId, editor]);
  // 范围指向的项目/业务范围被删掉时退回「全部项目」，并回到列表（那一层的资料与看板已经没有意义）。
  useEffect(() => {
    const gone = (scope.kind === "project" && !state.projects.some(p => p.id === scope.id)) || (scope.kind === "area" && !state.areas.some(a => a.id === scope.id));
    if (!gone) return;
    setScope({ kind: "all" }); setTab("tasks");
  }, [scope, state.projects, state.areas]);
  // A search hit opens the row it names. The row only renders when it survives the
  // filters, so the target's own scope replaces the current narrow one, and the
  // parameters are applied once so closing the details later keeps them closed.
  const [deepLink] = useSearchParams();
  const focusItem = deepLink.get("item") ?? "", focusProject = deepLink.get("project") ?? "";
  const appliedLink = useRef("");
  useEffect(() => {
    if (!focusItem && !focusProject) return;
    const link = `${focusProject}|${focusItem}`;
    if (appliedLink.current === link) return;
    const item = focusItem ? state.items.find(entry => entry.id === focusItem) : undefined;
    if (focusProject && state.projects.some(project => project.id === focusProject)) {
      appliedLink.current = link;
      setScope({ kind: "project", id: focusProject });
      setIterationFilter("all"); setStatusFilter("all"); setSelectedId(null); setTab("tasks");
      return;
    }
    if (!item) return;
    appliedLink.current = link;
    setScope(item.projectId ? { kind: "project", id: item.projectId } : { kind: "all" });
    setIterationFilter("all"); setStatusFilter("all"); setSelectedId(item.id); setTab("tasks");
  }, [focusItem, focusProject, state.items, state.projects]);
  function chooseScope(next: Scope) { setScope(next); setSelectedId(null); }
  async function editArea(id?: string) {
    const area = state.areas.find(a => a.id === id), name = await modal.prompt({ title: area ? c.editArea : c.newArea, initial: area?.name ?? "", confirmText: c.save });
    if (!name?.trim()) return;
    try { if (area) state.updateArea(area.id, name.trim()); else chooseScope({ kind: "area", id: state.addArea(name.trim()) }); } catch { toast.error(c.failed); }
  }
  async function deleteArea(id: string) { if (await modal.confirm({ title: c.deleteArea, description: c.deleteAreaHint, confirmText: c.remove, danger: true })) state.removeArea(id); }
  const iterationOptions = [{ value: "current", label: currentIteration ? `${c.currentIteration} · ${currentIteration.name}` : `${c.currentIteration} · ${c.noCurrentIteration}` }, { value: "none", label: c.unplanned }, { value: "all", label: c.allIterations }, ...iterations.map(i => ({ value: i.id, label: `${i.name} · ${i.start.slice(5)} – ${i.end.slice(5)}` }))];
  /** 总览里点「项目进度」的一行：把范围收到那一组。 */
  function openGroup(key: string) { if (key === "none") chooseScope({ kind: "unassigned" }); else if (key.startsWith("area:")) chooseScope({ kind: "area", id: key.slice(5) }); else chooseScope({ kind: "project", id: key }); }
  const title = selectedProject?.name ?? selectedArea?.name ?? (scope.kind === "unclassified" ? c.unclassified : scope.kind === "unassigned" ? c.noProject : c.title);
  const countOpen = (projectId: string) => state.items.filter(item => item.projectId === projectId && item.status !== "done" && item.status !== "cancelled").length;
  const projectRows = (areaId: string | null) => state.projects.filter(p => p.areaId === areaId && (showArchived || p.status !== "archived")).map(p => <button key={p.id} onClick={() => chooseScope({ kind: "project", id: p.id })} className={cn("group flex w-full min-w-0 items-center gap-2 rounded-md py-1.5 pr-2 pl-5 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring", scope.kind === "project" && scope.id === p.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")} title={p.name}><Folder className="size-3.5 shrink-0" /><span className={cn("min-w-0 flex-1 truncate", p.status === "archived" && "opacity-60")}>{p.name}</span><span className="text-[11px] tabular-nums">{p.status === "archived" ? c.archived : countOpen(p.id) || ""}</span></button>);
  return <div className="projects-page flex h-full min-h-0 flex-col p-4 lg:p-6">
    <header className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2"><FolderKanban className="size-5 shrink-0 text-primary" /><h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>{selectedProject?.status === "archived" && <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{c.archived}</span>}{selectedProject && <><Button variant="ghost" size="icon-sm" title={c.editProject} aria-label={c.editProject} onClick={() => setEditor({ kind: "project", id: selectedProject.id })}><Pencil /></Button><Button variant="ghost" size="icon-sm" title={c.reminderProject} aria-label={c.reminderProject} onClick={() => setEditor({ kind: "reminder", projectId: selectedProject.id })}><Bell /></Button></>}</div><div className="flex flex-wrap gap-2"><ZenConnectionsButton onClick={() => setZenOpen(true)} /><Button variant="outline" title={c.reminderGlobal} aria-label={c.reminderGlobal} size="icon" onClick={() => setEditor({ kind: "reminder" })}><Bell /></Button><Button onClick={() => setEditor({ kind: "item" })}><Plus />{c.newItem}</Button></div></header>
    {zenOpen && <ZenPanel onClose={() => setZenOpen(false)} />}
    <div className="projects-workspace min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-background"><div className={cn("projects-layout relative h-full min-h-0", selectedItem && activeTab !== "files" && "has-details")}>
      <nav className="projects-nav flex min-h-0 flex-col border-r border-border bg-muted/15 p-2" aria-label={c.projects}>
        <div className="space-y-0.5"><button onClick={() => chooseScope({ kind: "all" })} className={cn("projects-nav-row", scope.kind === "all" && "is-active")}><Layers3 className="size-4" /><span>{c.allProjects}</span><span className="ml-auto text-xs tabular-nums">{state.projects.filter(p => p.status === "active").length}</span></button><button onClick={() => chooseScope({ kind: "unassigned" })} className={cn("projects-nav-row", scope.kind === "unassigned" && "is-active")}><ListTodo className="size-4" /><span>{c.noProject}</span></button></div>
        <div className="mt-4 mb-1 flex items-center justify-between px-2"><h2 className="text-[11px] font-medium text-muted-foreground">{c.areas}</h2><Button variant="ghost" size="icon-xs" title={c.newArea} aria-label={c.newArea} onClick={() => void editArea()}><Plus /></Button></div>
        <div className="min-h-0 flex-1 overflow-y-auto space-y-2">{state.areas.map(area => <div key={area.id}><div className="group flex items-center"><button onClick={() => chooseScope({ kind: "area", id: area.id })} className={cn("projects-nav-row min-w-0 flex-1", scope.kind === "area" && scope.id === area.id && "is-active")} title={area.name}><ChevronRight className="size-3 shrink-0 text-muted-foreground" /><span className="truncate">{area.name}</span></button><div className="flex shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"><Button variant="ghost" size="icon-xs" title={`${c.editArea} · ${area.name}`} aria-label={`${c.editArea} · ${area.name}`} onClick={() => void editArea(area.id)}><Pencil /></Button><Button variant="ghost" size="icon-xs" title={`${c.deleteArea} · ${area.name}`} aria-label={`${c.deleteArea} · ${area.name}`} onClick={() => void deleteArea(area.id)}><Trash2 /></Button></div></div>{projectRows(area.id)}</div>)}<div><button onClick={() => chooseScope({ kind: "unclassified" })} className={cn("projects-nav-row", scope.kind === "unclassified" && "is-active")}><ChevronRight className="size-3 text-muted-foreground" /><span>{c.unclassified}</span></button>{projectRows(null)}</div></div>
        <div className="mt-2 space-y-2 border-t border-border pt-2"><Button className="w-full justify-start" variant="ghost" size="sm" onClick={() => setEditor({ kind: "project" })}><Plus />{c.newProject}</Button><label className="flex cursor-pointer items-center gap-2 px-2 pb-1 text-[11px] text-muted-foreground"><input type="checkbox" className="accent-primary" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />{c.showArchived}</label></div>
      </nav>
      <Tabs value={activeTab} onValueChange={value => setTab(value as WorkTab)} className="flex min-h-0 min-w-0 flex-col gap-0">
        <div className="flex h-11 shrink-0 items-center border-b border-border px-3"><TabsList aria-label={title}><TabsTrigger value="overview"><LayoutDashboard />{c.overview}</TabsTrigger><TabsTrigger value="tasks"><ListTodo />{c.tasks}</TabsTrigger><TabsTrigger value="board"><SquareKanban />{c.board}</TabsTrigger>{selectedProject && <TabsTrigger value="files"><Folder />{c.files}</TabsTrigger>}</TabsList></div>
        {(activeTab === "tasks" || activeTab === "board") && <>
          <ProjectViewsBar
            iteration={iterationFilter}
            status={statusFilter}
            search={search}
            onApply={(v) => {
              setIterationFilter(v.iteration);
              setStatusFilter(v.status);
              setSearch(v.search);
            }}
          />
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-3"><div className="min-w-[150px] flex-1"><ProjectSelect label={c.iteration} value={iterationFilter} onChange={setIterationFilter} options={iterationOptions} /></div><Button variant="ghost" size="icon-sm" title={c.newIteration} aria-label={c.newIteration} onClick={() => setEditor({ kind: "iteration" })}><Plus /></Button>{selectedIteration && <Button variant="ghost" size="icon-sm" title={c.editIteration} aria-label={c.editIteration} onClick={() => setEditor({ kind: "iteration", id: selectedIteration.id })}><Pencil /></Button>}<div className="w-[110px]"><ProjectSelect label={c.status} value={statusFilter} onChange={setStatusFilter} options={[{ value: "open", label: c.open }, { value: "all", label: c.all }, { value: "todo", label: c.todo }, { value: "doing", label: c.doing }, { value: "done", label: c.done }, { value: "cancelled", label: c.cancelled }]} /></div><div className="relative min-w-[150px] flex-1"><Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" /><Input value={search} onChange={e => setSearch(e.target.value)} className="pr-7 pl-8" placeholder={c.search} aria-label={c.search} />{search && <Button className="absolute top-0.5 right-0.5" variant="ghost" size="icon-sm" title={c.clearSearch} aria-label={c.clearSearch} onClick={() => setSearch("")}><X /></Button>}</div></div>
        </>}
        {activeTab === "overview" ? <TabsContent value="overview" aria-label={c.overview} className="flex min-h-0 flex-1 flex-col"><ProjectsOverview items={overviewItems} selectedId={selectedId} onSelect={setSelectedId} iterationFilter={iterationFilter} onIterationFilter={setIterationFilter} iterationOptions={iterationOptions} onOpenGroup={openGroup} /></TabsContent> : activeTab === "board" ? <TabsContent value="board" aria-label={c.board} className="flex min-h-0 flex-1 flex-col"><ProjectsBoard items={boardItems} selectedId={selectedId} onSelect={setSelectedId} carriedIds={carriedItemIds} statusFilter={statusFilter} onShowAllStatuses={() => setStatusFilter("all")} /></TabsContent> : filesProject ? <TabsContent value="files" aria-label={c.files} className="min-h-0 flex-1 overflow-auto p-3"><ProjectFiles projectId={filesProject.id} folder={filesProject.folder} onFolderChange={folder => state.updateProject(filesProject.id, { folder })} /></TabsContent> : <TabsContent value="tasks" aria-label={c.tasks} className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-4 text-xs text-muted-foreground"><span>{selectedIteration ? `${selectedIteration.start} – ${selectedIteration.end}` : iterationFilter === "all" ? c.allIterations : c.unplanned}</span><span className="tabular-nums" aria-live="polite">{filtered.length} {c.count}</span></div>
          {hiddenUnplannedSources > 0 && <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-2" data-zen-unplanned-hint><p className="text-xs text-muted-foreground">{hiddenUnplannedSources} {z.hiddenUnplanned}</p><Button size="sm" variant="link" className="h-auto p-0" onClick={() => { chooseScope({ kind: "all" }); setIterationFilter("none"); setStatusFilter("all"); setSearch(""); }}>{z.showUnplanned}</Button></div>}
          <div className="min-h-0 flex-1 overflow-y-auto">{!filtered.length ? <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 p-6 text-center"><ListTodo className="size-8 text-muted-foreground/50" /><div><p className="text-sm font-medium">{query ? c.noMatches : c.noItems}</p>{!query && <p className="mt-1 text-xs text-muted-foreground">{c.firstItem}</p>}</div>{!query && <Button size="sm" variant="outline" onClick={() => setEditor({ kind: "item" })}><Plus />{c.newItem}</Button>}</div> : <div role="list">{filtered.map(item => {
            const project = state.projects.find(p => p.id === item.projectId), area = state.areas.find(a => a.id === effectiveArea(item)), shown = historicalItem(item), date = itemDeadline(shown, state.iterations), closed = shown.status === "done" || shown.status === "cancelled", carried = filteredIterationId && item.activeIterationId !== filteredIterationId;
            return <div key={item.id} data-work-item={item.id} role="listitem" className={cn("group flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1 last:border-0", selectedId === item.id ? "bg-accent/70" : "hover:bg-muted/40")}><Button variant="ghost" size="icon-sm" className="shrink-0" disabled={Boolean(carried) || Boolean(item.mergedIntoId)} aria-label={`${closed ? c.restoreItem : c.completed} · ${item.title}`} title={closed ? c.restoreItem : c.completed} onClick={() => state.updateItem(item.id, { status: closed ? "todo" : "done" })}><StatusMark status={shown.status} /></Button><button className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-pressed={selectedId === item.id} onClick={() => setSelectedId(item.id)}><span className="min-w-[120px] flex-1"><span className={cn("block truncate text-sm", closed && "text-muted-foreground", shown.status === "done" && "line-through decoration-muted-foreground/40")}>{shown.title}{item.mergedIntoId ? ` · ${z.merged}` : ""}</span><span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"><span className="max-w-[180px] truncate">{project?.name ?? area?.name ?? c.noProject}</span>{shown.status === "doing" && <><span>·</span><span>{c.doing}</span></>}{carried && <span className="flex items-center gap-1"><ArrowRightLeft className="size-3" />{c.carried}</span>}</span></span>{date && <span className={cn("shrink-0 text-xs tabular-nums", date < today && !closed ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")} title={item.deadline ? `${c.deadline}: ${date}` : `${c.iterationDeadline}: ${date}`}>{deadlineLabel(date, c)}</span>}{Boolean(planCounts.get(item.id)) && <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums" title={c.plans}><CalendarDays className="size-3.5" />{planCounts.get(item.id)}</span>}<ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" /></button></div>;
          })}</div>}</div>
        </TabsContent>}
      </Tabs>
      {selectedItem && activeTab !== "files" && <div className="projects-details min-h-0"><ItemDetails key={selectedItem.id} item={selectedItem} onClose={closeDetails} onEdit={() => setEditor({ kind: "item", id: selectedItem.id })} onReminder={() => setEditor({ kind: "reminder", itemId: selectedItem.id })} /></div>}
    </div></div>
    {editor?.kind === "project" && <ProjectEditor key={editor.id ?? "new-project"} project={state.projects.find(p => p.id === editor.id)} areaId={selectedArea?.id} onClose={() => setEditor(null)} onSaved={id => { setEditor(null); chooseScope({ kind: "project", id }); }} />}
    {editor?.kind === "iteration" && <IterationEditor key={editor.id ?? "new-iteration"} iteration={state.iterations.find(i => i.id === editor.id)} onClose={() => setEditor(null)} onSaved={id => { setEditor(null); setIterationFilter(id); }} />}
    {editor?.kind === "item" && <ItemEditor key={editor.id ?? "new-item"} item={state.items.find(i => i.id === editor.id)} projectId={selectedProject?.id} areaId={selectedArea?.id} iterationId={filteredIterationId} onClose={() => setEditor(null)} onSaved={id => { setEditor(null); setSelectedId(id); }} />}
    {editor?.kind === "reminder" && (() => { const item = state.items.find(i => i.id === editor.itemId), project = state.projects.find(p => p.id === (editor.projectId ?? item?.projectId)); return <ReminderEditor title={item ? c.reminderItem : project ? c.reminderProject : c.reminderGlobal} rule={item ? item.reminder : project ? project.reminder : state.reminderRule} inherited={item ? project?.reminder ?? state.reminderRule : state.reminderRule} allowInherit={Boolean(item || project)} onClose={() => setEditor(null)} onSave={rule => { if (item) state.updateItem(item.id, { reminder: rule }); else if (project) state.updateProject(project.id, { reminder: rule }); else if (rule) state.setReminderRule(rule); }} />; })()}
  </div>;
}
