import { useTranslation } from "react-i18next";
import {
  minutesOf,
  rangeLabel,
  statusOf,
  type PlanTask,
} from "@/features/plans/types";
import { useDayTasks, useNow, usePlans } from "@/features/plans/store";
import { StatusButton, doneTitleStyle } from "@/features/plans/views/shared";
import { cn } from "@/lib/utils";

/** 时间轴视图：按时排序的时间轴 + 未定时区 */
export function TimelineView({ date }: { date: string }) {
  const { t } = useTranslation();
  const tasks = useDayTasks(date);
  const now = useNow();
  const toggleDone = usePlans((s) => s.toggleDone);

  // 有时间范围的任务按开始时间排；只有起点没终点的也归入定时区（按起点排）
  const timed = tasks
    .filter((task) => minutesOf(task.start) != null)
    .sort(
      (a, b) =>
        (minutesOf(a.start) ?? 0) - (minutesOf(b.start) ?? 0) || a.createdAt - b.createdAt,
    );
  const untimed = tasks.filter((task) => minutesOf(task.start) == null);

  return (
    <div className="flex flex-col gap-6">
      {timed.length > 0 && (
        <div className="relative ml-1 flex flex-col gap-3 border-l-2 border-border pl-5">
          {timed.map((task) => (
            <TimelineEntry
              key={task.id}
              task={task}
              date={date}
              now={now}
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
                <StatusButton
                  status={statusOf(task, date, now)}
                  onToggle={() => toggleDone(date, task.id)}
                />
                <span className="truncate text-[13px]" style={doneTitleStyle(task.done)}>
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
  date,
  now,
  depth,
  onToggle,
}: {
  task: PlanTask;
  date: string;
  now: Date;
  depth: number;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const status = statusOf(task, date, now);
  const range = rangeLabel(task);
  const doing = status === "doing";

  return (
    <div className="relative flex items-start gap-3" style={{ marginLeft: depth * 14 }}>
      <span className="absolute -left-[26px] top-2 grid size-3 place-items-center">
        <span
          className={cn(
            "size-2.5 rounded-full border-2",
            task.done
              ? "border-brand bg-brand"
              : doing
                ? "border-brand bg-brand/40"
                : "border-muted-foreground/50 bg-background",
          )}
        />
      </span>
      <div
        className={cn(
          "min-w-0 flex-1 rounded-lg border bg-card px-3 py-2",
          doing ? "border-brand/50 bg-brand/5" : "border-border",
        )}
      >
        <div className="flex items-center gap-2">
          <StatusButton status={status} onToggle={onToggle} />
          <span className="shrink-0 font-mono text-[12px] text-muted-foreground">
            {range ?? task.start}
          </span>
          <span className="min-w-0 truncate text-[13px]" style={doneTitleStyle(task.done)}>
            {task.title}
          </span>
          {doing && (
            <span className="shrink-0 rounded-full bg-brand px-1.5 py-px text-[10px] font-semibold text-white">
              {t("plans.status.doing")}
            </span>
          )}
        </div>
        {task.note && (
          <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{task.note}</p>
        )}
      </div>
    </div>
  );
}
