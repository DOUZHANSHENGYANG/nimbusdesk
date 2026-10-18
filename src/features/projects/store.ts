import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { onStorageSynced, tauriJsonStorage } from "@/lib/storage";
import { useStorageHealth } from "@/stores/storage-health";
import { carryItem, validateProjectData, validateReminderRule } from "./core";
import { emptyProjectData, type ProjectData, type NewItem, type NewProject, type Project, type WorkItem, type Iteration, type ReminderRule, type ReminderDelivery } from "./types";

interface ProjectStore extends ProjectData {
  addArea(name: string): string;
  updateArea(id: string, name: string): void;
  removeArea(id: string): void;
  addProject(input: NewProject): string;
  updateProject(id: string, patch: Partial<Omit<Project, "id" | "createdAt">>): void;
  addIteration(input: Pick<Iteration, "name" | "start" | "end">): string;
  updateIteration(id: string, patch: Partial<Pick<Iteration, "name" | "start" | "end">>): void;
  addItem(input: NewItem): string;
  updateItem(id: string, patch: Partial<Omit<WorkItem, "id" | "createdAt">>): void;
  removeItem(id: string): void;
  carryItem(id: string, iterationId: string | null): void;
  setReminderRule(rule: ReminderRule): void;
  markDelivered(delivery: ReminderDelivery): void;
}
const stamp = () => { const now = Date.now(); return { id: crypto.randomUUID(), createdAt: now, updatedAt: now }; };
function nameOf(name: string): string { const v = name.trim(); if (!v || v.length > 500) throw new Error("Enter a name (1–500 characters)"); return v; }
export function projectData(state: ProjectData): ProjectData {
  const { areas, projects, iterations, items, memberships, reminderRule, deliveries } = state;
  return { areas, projects, iterations, items, memberships, reminderRule, deliveries };
}
export const useProjects = create<ProjectStore>()(persist<ProjectStore, [], [], ProjectData>((set) => {
  const change = (fn: (data: ProjectData) => ProjectData) => set(current => {
    if (!useProjects.persist.hasHydrated()) throw new Error("Project data is still loading; please wait.");
    const next = fn(projectData(current)); validateProjectData(next); return next;
  });
  return {
    ...emptyProjectData(),
    addArea(name) { const entity = { ...stamp(), name: nameOf(name) }; change(d => ({ ...d, areas: [...d.areas, entity] })); return entity.id; },
    updateArea(id, name) { change(d => ({ ...d, areas: d.areas.map(a => a.id === id ? { ...a, name: nameOf(name), updatedAt: Date.now() } : a) })); },
    removeArea(id) { const now = Date.now(); change(d => ({ ...d, areas: d.areas.filter(a => a.id !== id), projects: d.projects.map(p => p.areaId === id ? { ...p, areaId: null, updatedAt: now } : p), items: d.items.map(i => i.areaId === id ? { ...i, areaId: null, updatedAt: now } : i) })); },
    addProject(input) { const entity: Project = { ...stamp(), name: nameOf(input.name), areaId: input.areaId || null, note: input.note || "", folder: null, status: "active" }; change(d => ({ ...d, projects: [...d.projects, entity] })); return entity.id; },
    updateProject(id, patch) { change(d => ({ ...d, projects: d.projects.map(p => p.id === id ? { ...p, ...patch, name: nameOf(patch.name ?? p.name), updatedAt: Date.now() } : p) })); },
    addIteration(input) { const entity: Iteration = { ...stamp(), ...input, name: nameOf(input.name) }; change(d => ({ ...d, iterations: [...d.iterations, entity] })); return entity.id; },
    updateIteration(id, patch) { change(d => ({ ...d, iterations: d.iterations.map(i => i.id === id ? { ...i, ...patch, name: nameOf(patch.name ?? i.name), updatedAt: Date.now() } : i) })); },
    addItem(input) {
      const entity: WorkItem = { ...stamp(), title: nameOf(input.title), projectId: input.projectId || null, areaId: input.projectId ? null : input.areaId || null, note: input.note || "", deadline: input.deadline || null, activeIterationId: null, status: "todo" };
      change(d => { const next = { ...d, items: [...d.items, entity] }; return input.activeIterationId ? carryItem(next, entity.id, input.activeIterationId) : next; });
      return entity.id;
    },
    updateItem(id, patch) { change(d => {
      let next = { ...d, items: d.items.map(i => i.id === id ? { ...i, ...patch, activeIterationId: i.activeIterationId, title: nameOf(patch.title ?? i.title), updatedAt: Date.now() } : i) };
      next.items = next.items.map(i => i.projectId ? { ...i, areaId: null } : i);
      if (patch.activeIterationId !== undefined) next = carryItem(next, id, patch.activeIterationId);
      return next;
    }); },
    removeItem(id) { change(d => ({ ...d, items: d.items.map(i => i.id === id ? { ...i, status: "cancelled", updatedAt: Date.now() } : i) })); },
    carryItem(id, target) { change(d => carryItem(d, id, target)); },
    setReminderRule(rule) { const valid = validateReminderRule(rule); change(d => ({ ...d, reminderRule: valid })); },
    markDelivered(delivery) { change(d => ({ ...d, deliveries: [...d.deliveries.filter(x => x.id !== delivery.id), delivery].slice(-4096) })); },
  };
}, {
  name: "projects", version: 1, storage: createJSONStorage(() => tauriJsonStorage), partialize: projectData,
  merge: (saved, current) => { if (!saved) return current; const data = { ...emptyProjectData(), ...(saved as ProjectData) }; validateProjectData(data); return { ...current, ...data }; },
  onRehydrateStorage: () => (_state, error) => { if (error) useStorageHealth.getState().report("unavailable", "projects", String(error)); },
}));

onStorageSynced((key, value) => {
  if (key !== "projects" || !value || typeof value !== "object") return;
  const data = (value as { state?: ProjectData }).state; if (!data) return;
  try { validateProjectData(data); useProjects.setState(data); }
  catch (error) { useStorageHealth.getState().report("unavailable", "projects", String(error)); }
});
