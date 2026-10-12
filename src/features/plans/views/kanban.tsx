import { useState } from "react";
import { Clock, Layers, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { childrenOf, type PlanTask, type TaskStatus } from "@/features/plans/types";
import { useDayTasks, usePlans } from "@/features/plans/store";
import { useModal } from "@/components/shell/modal-host";
import { StatusButton, doneTitleStyle } from "@/features/plans/views/shared";
import { cn } from "@/lib/utils";

const COLUMNS: TaskStatus[] = ["todo", "doing", "done"];

/** 看板视图：顶层计划按状态三列，原生拖拽换列 */
export function KanbanView({ date }: { date: string }) {
  const { t } = useTranslation();
  const tasks = useDayTasks(date);
  const setStatus = usePlans((s) => s.setStatus);
  const removeTask = usePlans((s) => s.removeTask);
  const addTask = usePlans((s) => s.addTask);
  const toggleDone = usePlans((s) => s.toggleDone);
  const { confirm } = useModal();
  const [overCol, setOverCol] = useState<TaskStatus | null>(null);

  const roots = childrenOf(tasks, null);

  const onDrop = (status: TaskStatus, e: React.DragEvent) => {
    e.preventDefault();
    setOverCol(null);
    const id = e.dataTransfer.getData("text/plain");
    if (id) setStatus(date, id, status);
  };

  const onDelete = async (task: PlanTask) => {
    const ok = await confirm({
      title: t("plans.deleteConfirm"),
      description: task.title,
      danger: true,
    });
    if (ok) removeTask(date, task.id);
  };

  return (
    <div className="grid grid-cols-3 gap-3">
      {COLUMNS.map((status) => {
        const colTasks = roots.filter((t) => t.status === status);
        return (
          <div
            key={status}
            onDragOver={(e) => {
              e.preventDefault();
              setOverCol(status);
            }}
            onDragLeave={() => setOverCol((c) => (c === status ? null : c))}
            onDrop={(e) => onDrop(status, e)}
            className={cn(
              "flex min-h-64 flex-col gap-2 rounded-xl border p-2.5 transition-colors duration-150",
              overCol === status
                ? "border-brand/60 bg-brand/5"
                : "border-border bg-muted/30",
            )}
          >
            <div className="flex items-center gap-2 px-1 pb-1">
              <span
                className={cn(
                  "size-2 rounded-full",
                  status === "todo" && "bg-muted-foreground/50",
                  status === "doing" && "bg-brand",
                  status === "done" && "bg-success",
                )}
              />
              <span className="text-[12px] font-semibold text-foreground/90">
                {t(`plans.status.${status}`)}
              </span>
              <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
                {colTasks.length}
              </span>
            </div>

            {colTasks.map((task) => (
              <div
                key={task.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("text/plain", task.id)}
                className="group cursor-grab rounded-lg border border-border bg-card p-2.5 shadow-[var(--pr-shadow-1)] transition-shadow hover:shadow-[var(--pr-shadow-2)] active:cursor-grabbing"
              >
                <div className="flex items-start gap-1.5">
                  <StatusButton
                    status={status}
                    onToggle={() => toggleDone(date, task.id)}
                    className="mt-0.5"
                  />
                  <p
                    className="min-w-0 flex-1 break-words text-[13px] leading-5"
                    style={doneTitleStyle(status === "done")}
                  >
                    {task.title}
                  </p>
                  <button
                    type="button"
                    onClick={() => void onDelete(task)}
                    className="shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/70 hover:!text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  {task.time && (
                    <span className="flex items-center gap-1 rounded-md bg-muted px-1.5 py-px font-mono text-[11px] text-muted-foreground">
                      <Clock className="size-3" />
                      {task.time}
                    </span>
                  )}
                  {childrenOf(tasks, task.id).length > 0 && (
                    <span className="flex items-center gap-1 rounded-md bg-muted px-1.5 py-px text-[11px] text-muted-foreground">
                      <Layers className="size-3" />
                      {t("plans.childrenCount", { count: childrenOf(tasks, task.id).length })}
                    </span>
                  )}
                </div>
              </div>
            ))}

            {status === "todo" && <AddCard onAdd={(title) => addTask(date, null, title)} />}
          </div>
        );
      })}
    </div>
  );
}

function AddCard({ onAdd }: { onAdd: (title: string) => void }) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");

  const submit = () => {
    const v = input.trim();
    if (!v) return;
    onAdd(v);
    setInput("");
  };

  return (
    <div className="mt-auto flex items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 py-2 transition-colors focus-within:border-brand/50">
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        onBlur={submit}
        placeholder={t("plans.addPlaceholder")}
        className="w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
      />
    </div>
  );
}
