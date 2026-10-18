import { validateProjectData } from "./core";
import type { ProjectData } from "./types";

function merge<T extends { id: string; updatedAt?: number; notifiedAt?: number }>(local: T[], incoming: T[]): T[] {
  const values = new Map(local.map(v => [v.id, v]));
  for (const v of incoming) {
    const old = values.get(v.id);
    if (!old || (v.updatedAt ?? v.notifiedAt ?? 0) > (old.updatedAt ?? old.notifiedAt ?? 0)) values.set(v.id, v);
  }
  return [...values.values()];
}
export function mergeProjectBackup(local: ProjectData, incoming: ProjectData, opts = { overwriteSettings: false }): ProjectData {
  validateProjectData(local); validateProjectData(incoming);
  const memberships = merge(local.memberships, incoming.memberships);
  const pairs = new Map<string, (typeof memberships)[number]>();
  for (const m of memberships) {
    const key = JSON.stringify([m.itemId, m.iterationId]), old = pairs.get(key);
    if (!old || m.updatedAt > old.updatedAt) pairs.set(key, m);
  }
  const data: ProjectData = {
    areas: merge(local.areas, incoming.areas),
    projects: merge(local.projects, incoming.projects).map(p => ({ ...p, folder: local.projects.find(x => x.id === p.id)?.folder ?? null })),
    iterations: merge(local.iterations, incoming.iterations), items: merge(local.items, incoming.items),
    memberships: [...pairs.values()], reminderRule: opts.overwriteSettings ? incoming.reminderRule : local.reminderRule, deliveries: merge(local.deliveries, incoming.deliveries).slice(-4096),
  };
  // Conflicting active-iteration graphs must be reviewed, never silently detached.
  validateProjectData(data); return data;
}
export function assertPlanLinks(envelope: unknown, workItems: Set<string>): void {
  if (!envelope || typeof envelope !== "object") return;
  const box = envelope as { state?: { days?: Record<string, unknown> }; days?: Record<string, unknown> };
  const days = (box.state ?? box).days;
  for (const day of Object.values(days ?? {})) {
    const tasks = Array.isArray(day) ? day : (day as { tasks?: unknown[] })?.tasks ?? [];
    const planIds = new Set<string>();
    for (const entry of tasks) {
      const id = (entry as { workItemId?: unknown })?.workItemId;
      if (entry && Object.prototype.hasOwnProperty.call(entry, "workItemId")) {
        const planId = (entry as { id?: unknown }).id;
        if (typeof planId !== "string" || !planId.trim() || planIds.has(planId)) throw new Error("Backup has an invalid or duplicated linked plan ID");
        planIds.add(planId);
      }
      if (id != null && (typeof id !== "string" || !workItems.has(id))) throw new Error("Backup has a plan linked to a missing project task; restore the matching project data first.");
    }
  }
}
