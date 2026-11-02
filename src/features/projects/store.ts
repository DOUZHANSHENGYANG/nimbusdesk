import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { onStorageSynced, tauriJsonStorage } from "@/lib/storage";
import { useStorageHealth } from "@/stores/storage-health";
import { carryItem, validateProjectData, validDate } from "./core";
import { snapshotOf, upsertSnapshot } from "./charts-core";
import { emptyProjectData, type ProjectData, type NewItem, type NewProject, type Project, type WorkItem, type Iteration } from "./types";
import { useZentao } from "./zentao-store";
import { reconcileZenChanges, recoverZenChanges } from "./zentao-writeback-core";

interface ProjectStore extends ProjectData {
  /** 删项目：项目本身移除，名下计划退回「无项目」，磁盘上的资料目录不动 */
  removeProject(id: string): void;
  addProject(input: NewProject): string;
  updateProject(id: string, patch: Partial<Omit<Project, "id" | "createdAt">>): void;
  /** 侧栏拖拽排序：只给被拖的这批重排，其余条目原地不动 */
  reorderProjects(ids: string[]): void;
  /** 置顶 / 取消置顶（置顶的排在列表最前，组内仍按拖出来的顺序） */
  toggleProjectPinned(id: string): void;  addIteration(input: Pick<Iteration, "name" | "start" | "end">): string;
  updateIteration(id: string, patch: Partial<Pick<Iteration, "name" | "start" | "end">>): void;
  addItem(input: NewItem): string;
  updateItem(id: string, patch: Partial<Omit<WorkItem, "id" | "createdAt">>): void;
  removeItem(id: string): void;
  /** 项目编辑弹框里的计划表格拖拽排序 */
  reorderItems(ids: string[]): void;
  carryItem(id: string, iterationId: string | null): void;
  /** 每天一条每项目一行，幂等：同一天重复调用只覆盖当天的数。 */
  recordSnapshot(date: string): void;
  refreshWriteback(): void;
}
const stamp = () => { const now = Date.now(); return { id: crypto.randomUUID(), createdAt: now, updatedAt: now }; };
function nameOf(name: string): string { const v = name.trim(); if (!v || v.length > 500) throw new Error("Enter a name (1–500 characters)"); return v; }

/**
 * 项目名唯一（同层唯一即可：项目是平铺的一列，重名之后侧栏里再也分不清谁是谁）。
 * 大小写与首尾空格不算区别：`Alpha` 与 ` alpha ` 视为同名。
 */
function assertUniqueProjectName(projects: { id: string; name: string }[], name: string, exceptId?: string): void {
  const key = name.trim().toLocaleLowerCase();
  if (projects.some((project) => project.id !== exceptId && project.name.trim().toLocaleLowerCase() === key)) {
    throw new Error("A project with that name already exists");
  }
}
/** 把一批条目按给定顺序放回它们原本占的位置：只影响这批，别的条目不动。 */
function reorder<T extends { id: string }>(list: T[], ids: string[]): T[] {
  const rank = new Map(ids.map((id, index) => [id, index]));
  const moved = list.filter(entry => rank.has(entry.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  let cursor = 0;
  return list.map(entry => rank.has(entry.id) ? moved[cursor++] : entry);
}
export function projectData(state: ProjectData): ProjectData {
  const { projects, iterations, items, memberships, snapshots = [], remoteTasks = [], remoteExecutions = [], remoteLinks = [], remoteChanges = [] } = state;
  return { projects, iterations, items, memberships, snapshots, remoteTasks, remoteExecutions, remoteLinks, remoteChanges };
}
export const useProjects = create<ProjectStore>()(persist<ProjectStore, [], [], ProjectData>((set) => {
  const change = (fn: (data: ProjectData) => ProjectData) => set(current => {
    if (!useProjects.persist.hasHydrated()) throw new Error("Project data is still loading; please wait.");
    const edited = fn(projectData(current));
    // Reminder bookkeeping may run before connection hydration. Unknown policies
    // must not be interpreted as deliberately disabling existing write intents.
    const next = useZentao.persist.hasHydrated() ? reconcileZenChanges(edited, useZentao.getState().connections) : edited;
    validateProjectData(next); return next;
  });
  return {
    ...emptyProjectData(),
    refreshWriteback() { change(d => d); },
    recordSnapshot(date) {
      if (!validDate(date)) return;
      change(d => {
        let snapshots = d.snapshots;
        for (const project of d.projects) snapshots = upsertSnapshot(snapshots, snapshotOf(project.id, d.items, date));
        return { ...d, snapshots };
      });
    },
    removeProject(id) { const now = Date.now(); change(d => ({ ...d, projects: d.projects.filter(p => p.id !== id), items: d.items.map(i => i.projectId === id ? { ...i, projectId: null, updatedAt: now } : i) })); },
    addProject(input) { const entity: Project = { ...stamp(), name: nameOf(input.name), note: input.note || "", folder: null, pinned: false, status: "active", tags: input.tags ? [...input.tags] : [], startDate: null, endDate: null, progressManual: null, icon: null, color: null }; change(d => { assertUniqueProjectName(d.projects, entity.name); return { ...d, projects: [...d.projects, entity] }; }); return entity.id; },
    updateProject(id, patch) { change(d => { const current = d.projects.find(p => p.id === id); const name = nameOf(patch.name ?? current?.name ?? ""); if (patch.name !== undefined) assertUniqueProjectName(d.projects, name, id); return { ...d, projects: d.projects.map(p => p.id === id ? { ...p, ...patch, name, updatedAt: Date.now() } : p) }; }); },
    toggleProjectPinned(id) { change(d => ({ ...d, projects: d.projects.map(p => p.id === id ? { ...p, pinned: !p.pinned, updatedAt: Date.now() } : p) })); },
    reorderProjects(ids) { change(d => ({ ...d, projects: reorder(d.projects, ids) })); },
    addIteration(input) { const entity: Iteration = { ...stamp(), ...input, name: nameOf(input.name) }; change(d => ({ ...d, iterations: [...d.iterations, entity] })); return entity.id; },
    updateIteration(id, patch) { change(d => ({ ...d, iterations: d.iterations.map(i => i.id === id ? { ...i, ...patch, name: nameOf(patch.name ?? i.name), updatedAt: Date.now() } : i) })); },
    addItem(input) {
      const entity: WorkItem = { ...stamp(), title: nameOf(input.title), projectId: input.projectId || null, note: input.note || "", deadline: input.deadline || null, activeIterationId: null, status: "todo", parentId: input.parentId ?? null, weight: input.weight ?? 1, percent: input.percent ?? null, startDate: input.startDate ?? null, endDate: input.endDate ?? null };
      change(d => { const next = { ...d, items: [...d.items, entity] }; return input.activeIterationId ? carryItem(next, entity.id, input.activeIterationId) : next; });
      return entity.id;
    },
    updateItem(id, patch) { change(d => {
      let next = { ...d, items: d.items.map(i => {
        if (i.id !== id) return i;
        const merged = { ...i, ...patch };
        // 状态与完成度单一真源：勾完成即 100，手动拉到 100 即完成，退回未完成时清掉 100。
        if (patch.status === "done" && patch.percent === undefined) merged.percent = 100;
        if (patch.percent === 100 && patch.status === undefined) merged.status = "done";
        if (patch.status && patch.status !== "done" && patch.percent === undefined && i.percent === 100) merged.percent = null;
        return { ...merged, activeIterationId: i.activeIterationId, title: nameOf(patch.title ?? i.title), updatedAt: Date.now() };
      }) };
      if (patch.activeIterationId !== undefined) next = carryItem(next, id, patch.activeIterationId);
      return next;
    }); },
    removeItem(id) { change(d => ({ ...d, items: d.items.map(i => i.id === id ? { ...i, status: "cancelled", updatedAt: Date.now() } : i) })); },
    reorderItems(ids) { change(d => ({ ...d, items: reorder(d.items, ids) })); },
    carryItem(id, target) { change(d => carryItem(d, id, target)); },
  };
}, {
  name: "projects", version: 1, storage: createJSONStorage(() => tauriJsonStorage), partialize: projectData,
  merge: (saved, current) => { if (!saved) return current; const data = recoverZenChanges({ ...emptyProjectData(), ...(saved as ProjectData) }); validateProjectData(data); return { ...current, ...data }; },
  onRehydrateStorage: () => (_state, error) => { if (error) useStorageHealth.getState().report("unavailable", "projects", String(error)); },
}));

onStorageSynced((key, value) => {
  if (key !== "projects" || !value || typeof value !== "object") return;
  const saved = (value as { state?: ProjectData }).state; if (!saved) return;
  const data = { ...emptyProjectData(), ...saved };
  try { validateProjectData(data); useProjects.setState(data); }
  catch (error) { useStorageHealth.getState().report("unavailable", "projects", String(error)); }
});
