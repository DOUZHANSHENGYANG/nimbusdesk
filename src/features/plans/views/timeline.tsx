import { useTranslation } from "react-i18next";
import type { PlanTask } from "@/features/plans/types";
import { useDayTasks, usePlans } from "@/features/plans/store";
import { StatusButton, doneTitleStyle } from "@/features/plans/views/shared";
import { cn } from "@/lib/utils";

/** 时间轴视图：按时排序的时间轴 + 未定时区 */
export function TimelineView({ date }: { date: string }) {
  const { t } = useTranslation();
  const tasks = useDayTasks(date);
  const toggleDone = usePlans((s) => s.toggleDone);

  const timed = tasks
    .filter((t) => t.time)
    .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "") || a.createdAt - b.createdAt);
  const untimed = tasks.filter((t) => !t.time);

  return (
    <div className="flex flex-col gap-6">
      {timed.length > 0 && (
        <div className="relative ml-1 flex flex-col gap-3 border-l-2 border-border pl-5">
          {timed.map((task) => (
            <TimelineEntry
              key={task.id}
              task={task}
              depth={depthOf(tasks, task)}
              onToggle={() => toggleDone(date, task.id)}
            />
          ))}
        </div>
      )}

      {timed.length === 0 && untimed.length === 0 && (
        <p className="py-6 text-center text-[13px] text-muted-foreground">{t("plans.emptyDay")}</p>
      )}

      {untimed.length > 0 && (
        <div>
          <p className="mb-2 text-[12px] font-semibold text-muted-foreground">
            {t("plans.untimed")}
          </p>
          <div className="flex flex-col gap-0.5">
            {untimed.map((task) => (
              <div
                key={task.id}
                className="flex min-h-8 items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-surface-hover"
              >
                <StatusButton status={task.status} onToggle={() => toggleDone(date, task.id)} />
                <span
                  className="truncate text-[13px]"
                  style={doneTitleStyle(task.status === "done")}
                >
                  {task.title}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function depthOf(all: PlanTask[], task: PlanTask): number {
  let d = 0;
  let p = task.parentId;
  while (p) {
    d++;
    p = all.find((x) => x.id === p)?.parentId ?? null;
  }
  return d;
}

function TimelineEntry({
  task,
  depth,
  onToggle,
}: {
  task: PlanTask;
  depth: number;
  onToggle: () => void;
}) {
  return (
    <div className="relative flex items-start gap-3" style={{ marginLeft: depth * 14 }}>
      <span className="absolute -left-[26px] top-2 grid size-3 place-items-center">
        <span
          className={cn(
            "size-2.5 rounded-full border-2",
            task.status === "done"
              ? "border-brand bg-brand"
              : "border-muted-foreground/50 bg-background",
          )}
        />
      </span>
      <span className="shrink-0 pt-0.5 font-mono text-[12px] text-muted-foreground">
        {task.time}
      </span>
      <div className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2">
        <div className="flex items-center gap-2">
          <StatusButton status={task.status} onToggle={onToggle} />
          <span
            className="truncate text-[13px]"
            style={doneTitleStyle(task.status === "done")}
          >
            {task.title}
          </span>
        </div>
        {task.note && (
          <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{task.note}</p>
        )}
      </div>
    </div>
  );
}
