import { FolderKanban } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useProjects } from "./store";
import { resolvePlanWorkItem } from "./core";
import { usePlans } from "@/features/plans/store";
import type { PlanTask } from "@/features/plans/types";
import { flushAllStorage } from "@/lib/storage";

export function PlanBinding({ date, task }: { date: string; task: PlanTask }) {
  const { i18n } = useTranslation(); const en = i18n.language.startsWith("en");
  const [ready, setReady] = useState(useProjects.persist.hasHydrated());
  useEffect(() => { if (useProjects.persist.hasHydrated()) setReady(true); return useProjects.persist.onFinishHydration(() => setReady(true)); }, []);
  const items = useProjects(s => s.items), projects = useProjects(s => s.projects);
  const tasks = usePlans(s => s.days[date]);
  const inherited = resolvePlanWorkItem(tasks ?? [], task.id);
  const value = task.workItemId === undefined ? "__inherit" : task.workItemId ?? "__none";
  return <label className="inline-flex min-w-0 max-w-56 items-center gap-1 text-xs text-muted-foreground" title={en ? "Link to a project task" : "关联项目任务"}>
    <FolderKanban className="size-3.5 shrink-0" />
    <select aria-label={en ? "Project task" : "关联项目任务"} disabled={!ready} value={value} className="min-w-0 max-w-48 truncate rounded-md bg-transparent py-1 outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50" onChange={async e => {
      const next = e.currentTarget.value;
      try { await flushAllStorage(); usePlans.getState().updateTask(date, task.id, { workItemId: next === "__inherit" ? undefined : next === "__none" ? null : next }); }
      catch (error) { toast.error(String(error)); }
    }}>
      <option value="__inherit">{task.parentId ? (en ? "Inherit parent" : "继承父计划") + (inherited ? ` · ${items.find(i => i.id === inherited)?.title ?? ""}` : "") : en ? "No project task" : "未关联任务"}</option>
      <option value="__none">{en ? "Standalone" : "保持游离"}</option>
      {items.filter(item => !item.mergedIntoId).map(item => <option key={item.id} value={item.id}>{item.projectId ? `${projects.find(p => p.id === item.projectId)?.name ?? ""} / ` : ""}{item.title}{item.status === "cancelled" ? (en ? " (cancelled)" : "（已取消）") : ""}</option>)}
    </select>
  </label>;
}
