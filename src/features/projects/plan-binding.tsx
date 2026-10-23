import { FolderKanban } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useProjects } from "./store";
import { resolvePlanWorkItem } from "./core";
import { usePlans } from "@/features/plans/store";
import type { PlanTask } from "@/features/plans/types";
import { flushAllStorage } from "@/lib/storage";

/**
 * 计划行上的「关联项目任务」。
 *
 * 用全应用那套 Radix 下拉（`components/ui/select`）而不是原生 `<select>`：
 * Windows 上原生下拉是系统画的浅灰菜单，深色主题里跟这套界面完全不是一个东西。
 * 触发器刻意做成无边框的行内样式（这一行本来就窄），并且不包在 `<label>` 里——
 * Radix 触发器自己是 button，包进 label 点文字会把弹层开了又关。
 */
export function PlanBinding({ date, task }: { date: string; task: PlanTask }) {
  const { i18n } = useTranslation();
  const en = i18n.language.startsWith("en");
  const [ready, setReady] = useState(useProjects.persist.hasHydrated());
  useEffect(() => { if (useProjects.persist.hasHydrated()) setReady(true); return useProjects.persist.onFinishHydration(() => setReady(true)); }, []);
  const items = useProjects(s => s.items), projects = useProjects(s => s.projects);
  const tasks = usePlans(s => s.days[date]);
  const inherited = resolvePlanWorkItem(tasks ?? [], task.id);
  const value = task.workItemId === undefined ? "__inherit" : task.workItemId ?? "__none";

  const options = [
    {
      value: "__inherit",
      label: task.parentId
        ? (en ? "Inherit parent" : "继承父计划") + (inherited ? ` · ${items.find(i => i.id === inherited)?.title ?? ""}` : "")
        : en ? "No project task" : "未关联任务",
    },
    { value: "__none", label: en ? "Standalone" : "保持游离" },
    ...items.filter(item => !item.mergedIntoId).map(item => ({
      value: item.id,
      label: `${item.projectId ? `${projects.find(p => p.id === item.projectId)?.name ?? ""} / ` : ""}${item.title}${item.status === "cancelled" ? (en ? " (cancelled)" : "（已取消）") : ""}`,
    })),
  ];

  const apply = async (next: string) => {
    try {
      await flushAllStorage();
      usePlans.getState().updateTask(date, task.id, { workItemId: next === "__inherit" ? undefined : next === "__none" ? null : next });
    } catch (error) { toast.error(String(error)); }
  };

  return <div className="inline-flex min-w-0 max-w-56 items-center gap-1 text-xs text-muted-foreground" title={en ? "Link to a project task" : "关联项目任务"}>
    <FolderKanban className="size-3.5 shrink-0" />
    <Select value={value} onValueChange={next => void apply(next)} disabled={!ready}>
      <SelectTrigger aria-label={en ? "Project task" : "关联项目任务"} size="sm"
        className="max-w-48 min-w-0 gap-1 border-transparent bg-transparent px-1 text-xs text-muted-foreground hover:bg-muted dark:bg-transparent dark:hover:bg-muted [&_svg]:size-3.5">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" sideOffset={4} align="start" className="max-w-[min(420px,90vw)]">
        {options.map(option => <SelectItem key={option.value} value={option.value} className="text-xs">{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  </div>;
}
