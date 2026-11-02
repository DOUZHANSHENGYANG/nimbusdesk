import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { CalendarDays, ChevronRight, FolderKanban, ListTodo, LoaderCircle, MoreHorizontal, Pencil, Pin, Plus, Search, X, ArrowRightLeft } from "lucide-react";
import { toast } from "sonner";
import { ProjectViewsBar } from "./views-bar";
import { ProjectsBoard } from "./board";
import { ProjectsOverview } from "./overview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useModal } from "@/components/shell/modal-host";
import { useStorageHealth } from "@/stores/storage-health";
import { cn } from "@/lib/utils";
import { todayStr } from "@/features/plans/types";
import { usePlans, usePlansArchive } from "@/features/plans/store";
import { usePointerDrag } from "@/features/plans/use-pointer-drag";
import { useProjects } from "./store";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { planPercent, resolveActiveTab, resolvePlanWorkItem, orderedProjects } from "./core";
import { ItemEditor, IterationEditor, ProjectSelect, type ItemRecord } from "./forms";
import { ProjectEditor } from "./project-editor";
import { ItemDetails, StatusMark, itemDeadline, deadlineLabel } from "./details";
import { ProjectFiles } from "./files";
import { ProjectCharts } from "./charts";
import { useProjectsCopy } from "./copy";
import { ZenPanel, ZenConnectionsButton } from "./zentao-panel";
import { useZentao } from "./zentao-store";
import { useZenCopy } from "./zentao-copy";
import { ProjectGlyph } from "./project-icon";
import "./projects.css";

type Editor = { kind: "project" | "iteration" | "item"; id?: string } | null;
type WorkTab = "overview" | "tasks" | "board" | "files" | "charts";

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
  // 每天首次打开记一条快照：图表没有历史就没有形状，就在这里攒。幂等，同一天只覆盖。
  useEffect(() => { useProjects.getState().recordSnapshot(todayStr()); }, []);
  const projects = state.projects;
  const [projectId, setProjectId] = useState<string | null>(null), [iterationFilter, setIterationFilter] = useState("current"), [statusFilter, setStatusFilter] = useState("open"), [search, setSearch] = useState(""), [selectedId, setSelectedId] = useState<string | null>(null), [tab, setTab] = useState<WorkTab>("overview"), [editor, setEditor] = useState<Editor>(null);
  const query = useDeferredValue(search.trim().toLocaleLowerCase()), today = todayStr();
  // 侧栏只列项目，没有「全部计划」这一层：没选中时落到第一个在办项目。
  useEffect(() => {
    if (projectId && projects.some(project => project.id === projectId)) return;
    setProjectId(projects.find(project => project.status === "active")?.id ?? projects[0]?.id ?? null);
  }, [projectId, projects]);
  const iterations = useMemo(() => [...state.iterations].sort((a, b) => b.start.localeCompare(a.start) || b.createdAt - a.createdAt), [state.iterations]);
  const currentIteration = iterations.find(i => i.start <= today && i.end >= today);
  const filteredIterationId = iterationFilter === "current" ? currentIteration?.id ?? null : iterationFilter === "all" || iterationFilter === "none" ? null : iterationFilter;
  const selectedProject = projects.find(project => project.id === projectId);
  const selectedIteration = iterations.find(i => i.id === filteredIterationId);
  // 单一真相：tab 只有落在「有对应面板」的值上，才当成当前页。文件页没有选中项目时退回任务列表，
  // 这样任何 setTab 写错值都不会出现「切过去一片空白」。
  const activeTab: WorkTab = resolveActiveTab(tab, Boolean(selectedProject));
  const filesProject = activeTab === "files" ? selectedProject : undefined;
  const historicalItem = (item: ItemRecord): ItemRecord => {
    const membership = filteredIterationId ? state.memberships.find(m => m.itemId === item.id && m.iterationId === filteredIterationId && m.leftAt !== null) : undefined;
    return membership?.snapshot ? { ...item, ...membership.snapshot, activeIterationId: filteredIterationId } : item;
  };
  // 一份筛选谓词，两处消费：列表与看板要状态和搜索，总览只要范围与迭代——
  // 总览展示的就是状态分布，先按状态筛再统计会自相矛盾。
  function itemMatches(item: ItemRecord, withStatus: boolean, withQuery: boolean): boolean {
    if (item.projectId !== projectId) return false;
    const shown = historicalItem(item);
    if (iterationFilter !== "all") {
      if (iterationFilter === "none" || (iterationFilter === "current" && !filteredIterationId)) { if (item.activeIterationId !== null) return false; }
      else if (!state.memberships.some(m => m.itemId === item.id && m.iterationId === filteredIterationId) && item.activeIterationId !== filteredIterationId) return false;
    }
    if (withStatus) {
      if (statusFilter === "open" && (shown.status === "done" || shown.status === "cancelled")) return false;
      if (statusFilter !== "open" && statusFilter !== "all" && shown.status !== statusFilter) return false;
    }
    return !withQuery || !query || [shown.title, item.title, item.note].some(value => value?.toLocaleLowerCase().includes(query));
  }
  const filtered = useMemo(() => state.items.filter(item => itemMatches(item, true, true)).sort((a, b) => {
    const aShown = historicalItem(a), bShown = historicalItem(b), aClosed = aShown.status === "done" || aShown.status === "cancelled", bClosed = bShown.status === "done" || bShown.status === "cancelled";
    return Number(aClosed) - Number(bClosed) || (itemDeadline(aShown, state.iterations) ?? "9999").localeCompare(itemDeadline(bShown, state.iterations) ?? "9999") || a.createdAt - b.createdAt;
  }), [state.items, state.memberships, state.iterations, projectId, iterationFilter, filteredIterationId, statusFilter, query]);
  // 总览那一批：同样的范围与迭代，但不吃状态与搜索，且套上历史迭代快照（口径与列表一致）。
  const overviewItems = useMemo(() => state.items.filter(item => itemMatches(item, false, false)).map(historicalItem), [state.items, state.memberships, state.iterations, projectId, iterationFilter, filteredIterationId, statusFilter, query]);
  // 列表的层级与计划进度一次算好：每行递归会给长列表带来 O(n²)。
  const planMeta = useMemo(() => {
    const byId = new Map(state.items.map(item => [item.id, item]));
    const depth = new Map<string, number>(), percent = new Map<string, number>(), parents = new Set<string>();
    for (const item of state.items) {
      let level = 0, cursor = item.parentId ? byId.get(item.parentId) : undefined;
      while (cursor && level < 12) { level++; cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined; }
      depth.set(item.id, level);
      percent.set(item.id, planPercent(state.items, item.id));
      if (item.parentId) parents.add(item.parentId);
    }
    return { depth, percent, parents };
  }, [state.items]);
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
  // 选中的项目被删掉时退回第一个项目（那一层的资料与看板已经没有意义）。
  useEffect(() => {
    if (projectId && !projects.some(project => project.id === projectId)) { setProjectId(null); setTab("tasks"); }
  }, [projectId, projects]);
  // A search hit opens the row it names. The row only renders when it survives the
  // filters, so the target's own project replaces the current one, and the
  // parameters are applied once so closing the details later keeps them closed.
  const [deepLink] = useSearchParams();
  const focusItem = deepLink.get("item") ?? "", focusProject = deepLink.get("project") ?? "";
  const appliedLink = useRef("");
  useEffect(() => {
    if (!focusItem && !focusProject) return;
    const link = `${focusProject}|${focusItem}`;
    if (appliedLink.current === link) return;
    const item = focusItem ? state.items.find(entry => entry.id === focusItem) : undefined;
    if (focusProject && projects.some(project => project.id === focusProject)) {
      appliedLink.current = link;
      setProjectId(focusProject);
      setIterationFilter("all"); setStatusFilter("all"); setSelectedId(null); setTab("tasks");
      return;
    }
    if (!item) return;
    appliedLink.current = link;
    setProjectId(item.projectId);
    setIterationFilter("all"); setStatusFilter("all"); setSelectedId(item.id); setTab("tasks");
  }, [focusItem, focusProject, state.items, projects]);
  function chooseProject(id: string) { setProjectId(id); setSelectedId(null); }
  /** 拖一个项目到另一个项目上：把它插到目标位置，其余顺序不动。 */
  function moveProject(id: string, targetId: string) {
    if (id === targetId) return;
    const ids = projects.map(project => project.id), from = ids.indexOf(id), to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    try { state.reorderProjects(ids); } catch { toast.error(c.failed); }
  }
  // WebView2 开着原生拖放时 HTML5 拖拽会被接管，页面内排序必须走 pointer。
  const railDrag = usePointerDrag<string>({
    hitTest: element => element?.closest<HTMLElement>("[data-project-id]")?.dataset.projectId ?? null,
    onDrop: moveProject,
  });
  /** 键盘换位走「当前看见的相邻项」：置顶的排在前，但拖动/换位都按身份换，不受分组影响 */
  const reorderKey = (id: string, event: ReactKeyboardEvent<HTMLElement>) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const index = ordered.findIndex(project => project.id === id);
    const neighbour = ordered[index + (event.key === "ArrowUp" ? -1 : 1)];
    if (neighbour) moveProject(id, neighbour.id);
  };
  async function createProject() {
    const name = await modal.prompt({ title: c.newProject, initial: "", confirmText: c.add });
    if (!name?.trim()) return;
    try { chooseProject(state.addProject({ name: name.trim() })); }
    catch (cause) { toast.error(String(cause).includes("already exists") ? c.nameTaken : c.failed); }
  }
  /** 显示顺序：置顶在前，其余按数组顺序（即拖出来的顺序） */
  const ordered = useMemo(() => orderedProjects(projects), [projects]);
  const pinnedRows = ordered.filter(project => project.pinned);
  const otherRows = ordered.filter(project => !project.pinned);
  /** 一行项目：行盒子包住名字与「更多」菜单（两者同属一行，不是并排两个方块） */
  const renderProjectRow = (project: typeof projects[number]) => (
    <div key={project.id} data-project-id={project.id} onPointerDown={event => railDrag.start(event, project.id)}
      className={cn("projects-nav-row group", projectId === project.id && "is-active", railDrag.dragging === project.id && "opacity-40", railDrag.over === project.id && railDrag.dragging !== project.id && "ring-1 ring-primary/60")}>
      <div role="button" tabIndex={0} onClick={() => chooseProject(project.id)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); chooseProject(project.id); } else reorderKey(project.id, event); }} aria-pressed={projectId === project.id} title={project.name}
        className="flex min-w-0 flex-1 cursor-default select-none items-center gap-2 outline-none">
        <ProjectGlyph icon={project.icon} color={project.color} /><span className={cn("min-w-0 flex-1 truncate", project.status === "archived" && "opacity-60")}>{project.name}</span>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" className="shrink-0 text-current opacity-60 hover:opacity-100" title={`${c.moreActions} · ${project.name}`} aria-label={`${c.moreActions} · ${project.name}`}>
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-36">
          <DropdownMenuItem onSelect={() => state.toggleProjectPinned(project.id)}>
            <Pin className={cn("size-3.5", project.pinned && "fill-current")} />{project.pinned ? c.unpinProject : c.pinProject}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setEditor({ kind: "project", id: project.id })}>
            <Pencil className="size-3.5" />{c.editProject}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
  const iterationOptions = [{ value: "current", label: currentIteration ? `${c.currentIteration} · ${currentIteration.name}` : `${c.currentIteration} · ${c.noCurrentIteration}` }, { value: "none", label: c.unplanned }, { value: "all", label: c.allIterations }, ...iterations.map(i => ({ value: i.id, label: `${i.name} · ${i.start.slice(5)} – ${i.end.slice(5)}` }))];
  const viewTabs: { value: WorkTab; label: string }[] = [
    { value: "overview", label: c.overview },
    { value: "tasks", label: c.tasks },
    { value: "board", label: c.board },
  ];
  if (selectedProject) viewTabs.push({ value: "files", label: c.files });
  if (selectedProject) viewTabs.push({ value: "charts", label: c.charts });
  return <div className="projects-page flex h-full min-h-0 flex-col p-4 lg:p-6">
    {zenOpen && <ZenPanel onClose={() => setZenOpen(false)} />}
    <div className="projects-workspace min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-background"><div className={cn("projects-layout relative h-full min-h-0", selectedItem && activeTab !== "files" && activeTab !== "charts" && "has-details")}>
      <nav className="projects-nav flex min-h-0 flex-col border-r border-border bg-muted/15 p-2" aria-label={c.projects}>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {/* 置顶单独成组：光把行排到前面，用户看不出「为什么它在上面」 */}
          {pinnedRows.length ? (
            <>
              <p className="px-2 pt-0.5 pb-1 text-[10.5px] font-medium text-muted-foreground/70">{c.pinnedGroup}</p>
              {pinnedRows.map(renderProjectRow)}
              {otherRows.length ? <div aria-hidden className="mx-2 my-1 h-px bg-border" /> : null}
            </>
          ) : null}
          {otherRows.map(renderProjectRow)}
          {!projects.length && <p className="px-2 py-1 text-xs text-muted-foreground">{c.noProjects}</p>}
        </div>
      </nav>
      {selectedProject ? <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex h-11 shrink-0 items-center border-b border-border px-3">
          <nav className="projects-modes" aria-label={c.title}>
            {viewTabs.map(item => <button key={item.value} type="button" aria-pressed={activeTab === item.value} onClick={() => setTab(item.value)}>{item.label}</button>)}
          </nav>
          {/* 项目名已在左侧列表里高亮，这里只留操作；主操作靠右 */}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void createProject()}><Plus />{c.newProject}</Button>
            <ZenConnectionsButton onClick={() => setZenOpen(true)} />
          </div>
        </div>
        {(activeTab === "tasks" || activeTab === "board") && <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-2 pb-1.5">
          <div className="flex h-7 items-center rounded-lg border border-input pr-0.5">
            <div className="w-[158px]"><ProjectSelect size="sm" label={c.iteration} value={iterationFilter} onChange={setIterationFilter} options={iterationOptions} className="border-0 bg-transparent text-xs shadow-none [&_svg]:size-3.5 dark:bg-transparent" /></div>
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground" title={c.newIteration} aria-label={c.newIteration} onClick={() => setEditor({ kind: "iteration" })}><Plus /></Button>
            {selectedIteration && <Button variant="ghost" size="icon-xs" className="text-muted-foreground" title={c.editIteration} aria-label={c.editIteration} onClick={() => setEditor({ kind: "iteration", id: selectedIteration.id })}><Pencil /></Button>}
          </div>
          <div className="w-[108px]"><ProjectSelect size="sm" label={c.status} value={statusFilter} onChange={setStatusFilter} className="text-xs [&_svg]:size-3.5" options={[{ value: "open", label: c.open }, { value: "all", label: c.all }, { value: "todo", label: c.todo }, { value: "doing", label: c.doing }, { value: "done", label: c.done }, { value: "cancelled", label: c.cancelled }]} /></div>
          <div className="relative min-w-[150px] max-w-[280px] flex-1"><Search className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-muted-foreground" /><Input value={search} onChange={e => setSearch(e.target.value)} className="h-7 pr-7 pl-8 text-xs" placeholder={c.search} aria-label={c.search} />{search && <Button className="absolute top-0 right-0.5 h-7" variant="ghost" size="icon-xs" title={c.clearSearch} aria-label={c.clearSearch} onClick={() => setSearch("")}><X /></Button>}</div>
          <span className="ml-auto hidden shrink-0 items-center gap-2 pl-1 text-[11px] text-muted-foreground sm:flex"><span className="tabular-nums">{selectedIteration ? `${selectedIteration.start} – ${selectedIteration.end}` : iterationFilter === "all" ? c.allIterations : c.unplanned}</span><span aria-live="polite" className="tabular-nums">{filtered.length} {c.count}</span></span>
          <ProjectViewsBar iteration={iterationFilter} status={statusFilter} search={search} onApply={(v) => { setIterationFilter(v.iteration); setStatusFilter(v.status); setSearch(v.search); }} />
        </div>}
        {activeTab === "overview" ? <div aria-label={c.overview} className="flex min-h-0 flex-1 flex-col animate-in fade-in-0 slide-in-from-bottom-1 duration-200"><ProjectsOverview items={overviewItems} selectedId={selectedId} onSelect={setSelectedId} iterationFilter={iterationFilter} onIterationFilter={setIterationFilter} iterationOptions={iterationOptions} onOpenGroup={chooseProject} /></div>
          : activeTab === "board" ? <div aria-label={c.board} className="flex min-h-0 flex-1 flex-col animate-in fade-in-0 slide-in-from-bottom-1 duration-200"><ProjectsBoard items={boardItems} selectedId={selectedId} onSelect={setSelectedId} carriedIds={carriedItemIds} statusFilter={statusFilter} onShowAllStatuses={() => setStatusFilter("all")} /></div>
          : filesProject ? <div aria-label={c.files} className="min-h-0 flex-1 overflow-auto p-4 animate-in fade-in-0 slide-in-from-bottom-1 duration-200"><ProjectFiles projectId={filesProject.id} folder={filesProject.folder} onFolderChange={folder => state.updateProject(filesProject.id, { folder })} /></div>
          : activeTab === "charts" && selectedProject ? <div aria-label={c.charts} className="min-h-0 flex-1 overflow-auto animate-in fade-in-0 slide-in-from-bottom-1 duration-200"><ProjectCharts projectId={selectedProject.id} /></div>
          : <div aria-label={c.tasks} className="flex min-h-0 flex-1 flex-col animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
            {hiddenUnplannedSources > 0 && <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-2" data-zen-unplanned-hint><p className="text-xs text-muted-foreground">{hiddenUnplannedSources} {z.hiddenUnplanned}</p><Button size="sm" variant="link" className="h-auto p-0" onClick={() => { setIterationFilter("none"); setStatusFilter("all"); setSearch(""); }}>{z.showUnplanned}</Button></div>}
            <div className="min-h-0 flex-1 overflow-y-auto">{!filtered.length ? <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 p-6 text-center"><ListTodo className="size-8 text-muted-foreground/50" /><div><p className="text-sm font-medium">{query ? c.noMatches : c.noItems}</p>{!query && <p className="mt-1 text-xs text-muted-foreground">{c.firstItem}</p>}</div>{!query && <Button size="sm" variant="outline" onClick={() => setEditor({ kind: "item" })}><Plus />{c.newItem}</Button>}</div> : <div role="list">{filtered.map(item => {
              const project = projects.find(p => p.id === item.projectId), shown = historicalItem(item), date = itemDeadline(shown, state.iterations), closed = shown.status === "done" || shown.status === "cancelled", carried = filteredIterationId && item.activeIterationId !== filteredIterationId, level = planMeta.depth.get(item.id) ?? 0, showPct = planMeta.parents.has(item.id) || item.percent != null, pct = planMeta.percent.get(item.id) ?? 0;
              return <div key={item.id} data-work-item={item.id} role="listitem" style={{ paddingLeft: `${16 + level * 16}px` }} className={cn("group flex min-w-0 items-center gap-2 border-b border-border/60 px-4 py-2 last:border-0", selectedId === item.id ? "bg-accent/70" : "hover:bg-muted/40")}><Button variant="ghost" size="icon-sm" className="shrink-0" disabled={Boolean(carried) || Boolean(item.mergedIntoId)} aria-label={`${closed ? c.restoreItem : c.completed} · ${item.title}`} title={closed ? c.restoreItem : c.completed} onClick={() => state.updateItem(item.id, { status: closed ? "todo" : "done" })}><StatusMark status={shown.status} /></Button>{showPct && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground" title={c.percent}>{pct}%</span>}<button className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md py-2 text-left" aria-pressed={selectedId === item.id} onClick={() => setSelectedId(item.id)}><span className="min-w-[120px] flex-1"><span className={cn("block truncate text-sm", closed && "text-muted-foreground", shown.status === "done" && "line-through decoration-muted-foreground/40")}>{shown.title}{item.mergedIntoId ? ` · ${z.merged}` : ""}</span><span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"><span className="max-w-[180px] truncate">{project?.name ?? c.noProject}</span>{shown.status === "doing" && <><span>·</span><span>{c.doing}</span></>}{carried && <span className="flex items-center gap-1"><ArrowRightLeft className="size-3" />{c.carried}</span>}</span></span>{date && <span className={cn("shrink-0 text-xs tabular-nums", date < today && !closed ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")} title={item.deadline ? `${c.deadline}: ${date}` : `${c.iterationDeadline}: ${date}`}>{deadlineLabel(date, c)}</span>}{Boolean(planCounts.get(item.id)) && <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums" title={c.plans}><CalendarDays className="size-3.5" />{planCounts.get(item.id)}</span>}<ChevronRight className="size-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" /></button></div>;
            })}</div>}</div>
          </div>}
      </div> : <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"><FolderKanban className="size-8 text-muted-foreground/50" /><p className="text-sm text-muted-foreground">{projects.length ? c.pickProject : c.noProjects}</p><div className="flex items-center gap-2"><Button size="sm" variant="outline" onClick={() => void createProject()}><Plus />{c.newProject}</Button><ZenConnectionsButton onClick={() => setZenOpen(true)} /></div></div>}
      {selectedItem && activeTab !== "files" && activeTab !== "charts" && <div className="projects-details min-h-0"><ItemDetails key={selectedItem.id} item={selectedItem} onClose={closeDetails} onEdit={() => setEditor({ kind: "item", id: selectedItem.id })} /></div>}
    </div></div>
    {editor?.kind === "project" && state.projects.some(project => project.id === editor.id) && <ProjectEditor key={editor.id} project={state.projects.find(project => project.id === editor.id)!} onClose={() => setEditor(null)} onDelete={async () => { const target = state.projects.find(project => project.id === editor.id); if (!target) return; if (await modal.confirm({ title: c.deleteProject, description: c.deleteProjectHint, confirmText: c.remove, danger: true })) { state.removeProject(target.id); setEditor(null); } }} />}
    {editor?.kind === "iteration" && <IterationEditor key={editor.id ?? "new-iteration"} iteration={state.iterations.find(i => i.id === editor.id)} onClose={() => setEditor(null)} onSaved={id => { setEditor(null); setIterationFilter(id); }} />}
    {editor?.kind === "item" && <ItemEditor key={editor.id ?? "new-item"} item={state.items.find(i => i.id === editor.id)} projectId={selectedProject?.id} iterationId={filteredIterationId} onClose={() => setEditor(null)} onSaved={id => { setEditor(null); setSelectedId(id); }} />}
  </div>;
}
