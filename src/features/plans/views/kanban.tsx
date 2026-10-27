import { useCallback, useState } from "react";
import { usePointerDrag } from "@/features/plans/use-pointer-drag";
import { Layers, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  childrenOf,
  rangeLabel,
  statusOf,
  type PlanTask,
} from "@/features/plans/types";
import { useDayTasks, useNow, usePlans } from "@/features/plans/store";
import { useModal } from "@/components/shell/modal-host";
import { StatusButton, doneTitleStyle } from "@/features/plans/views/shared";
import { cn } from "@/lib/utils";

/**
 * 看板视图：两列（待办 / 已完成）。
 *
 * 「进行中」不再是可拖入的列 —— 它由时间范围推导（到点自动开始），
 * 若还允许手工拖进去，就会出现「手动设为进行中，但时间没到」的矛盾状态。
 * 进行中的任务在待办列里以高亮卡片呈现。
 */
const COLUMNS = ["todo", "done"] as const;

export function KanbanView({ date }: { date: string }) {
  const { t } = useTranslation();
  const tasks = useDayTasks(date);
  const now = useNow();
  const toggleDone = usePlans((s) => s.toggleDone);
  const removeTask = usePlans((s) => s.removeTask);
  const addTask = usePlans((s) => s.addTask);
  const { confirm } = useModal();
  /** 正在编辑的任务 id（就地改名） */
  const [editingId, setEditingId] = useState<string | null>(null);

  const roots = childrenOf(tasks, null);

  /**
   * 拖到「已完成」= 勾选完成；拖回「待办」= 取消完成。
   *
   * 走 pointer 事件而不是 HTML5 DnD：Tauri 的原生拖放会接管后者，浏览器里能拖、真机上不动。
   */
  const applyDrop = useCallback(
    (id: string, col: string) => {
      const task = tasks.find((x) => x.id === id);
      if (!task) return;
      if (task.done !== (col === "done")) toggleDone(date, id);
    },
    [tasks, toggleDone, date],
  );
  const hitTest = useCallback(
    (element: HTMLElement | null) => element?.closest("[data-kanban-col]")?.getAttribute("data-kanban-col") ?? null,
    [],
  );
  const drag = usePointerDrag<string>({ hitTest, onDrop: applyDrop });

  const onDelete = async (task: PlanTask) => {
    const ok = await confirm({
      title: t("plans.deleteConfirm"),
      description: task.title,
      danger: true,
    });
    if (ok) removeTask(date, task.id);
  };

  return (
    <div className="grid grid-cols-2 gap-4">
      {COLUMNS.map((col) => {
        const colTasks = roots.filter((task) => {
          const done = task.done;
          return col === "done" ? done : !done;
        });

        return (
          <div
            key={col}
            data-kanban-col={col}
            className={cn(
              "flex min-h-72 flex-col gap-2.5 rounded-2xl border p-3 transition-colors duration-150",
              drag.over === col
                ? "border-brand/60 bg-brand/5"
                : "border-border bg-muted/30",
            )}
          >
            <div className="flex items-center gap-2 px-1 pb-0.5">
              <span
                className={cn(
                  "size-2 rounded-full",
                  col === "todo" ? "bg-muted-foreground/50" : "bg-success",
                )}
              />
              <span className="text-[13px] font-semibold text-foreground/90">
                {t(`plans.status.${col}`)}
              </span>
              <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
                {colTasks.length}
              </span>
            </div>

            {colTasks.map((task) => {
              const status = statusOf(task, date, now);
              const range = rangeLabel(task);
              const kids = childrenOf(tasks, task.id);
              return (
                <div
                  key={task.id}
                  onPointerDown={(e) => drag.start(e, task.id)}
                  className={cn(
                    "group cursor-grab touch-none rounded-xl border bg-card p-3 shadow-[var(--pr-shadow-1)] transition-shadow hover:shadow-[var(--pr-shadow-2)] active:cursor-grabbing",
                    status === "doing" ? "border-brand/50" : "border-border",
                    drag.dragging === task.id && "opacity-60",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <StatusButton
                      status={status}
                      onToggle={() => toggleDone(date, task.id)}
                      className="mt-0.5"
                    />
                    <p
                      className="min-w-0 flex-1 break-words text-[13px] leading-5"
                      style={doneTitleStyle(task.done)}
                    >
                      {task.title}
                    </p>
                    <button
                      type="button"
                      onClick={() => setEditingId(editingId === task.id ? null : task.id)}
                      className="shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/70 hover:!text-brand"
                      title={t("plans.editTip")}
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDelete(task)}
                      className="shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/70 hover:!text-destructive"
                      title={t("common.confirm")}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>

                  {editingId === task.id && (
                    <input
                      autoFocus
                      defaultValue={task.title}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== task.title) {
                          usePlans.getState().updateTask(date, task.id, { title: v });
                        }
                        setEditingId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      className="mt-1.5 w-full rounded-md border border-brand/40 bg-background px-2 py-1 text-[13px] outline-none"
                    />
                  )}

                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {range && (
                      <span className="rounded-md bg-muted px-1.5 py-px font-mono text-[11px] text-muted-foreground">
                        {range}
                      </span>
                    )}
                    {status === "doing" && (
                      <span className="rounded-md bg-brand px-1.5 py-px text-[11px] font-medium text-white">
                        {t("plans.status.doing")}
                      </span>
                    )}
                    {kids.length > 0 && (
                      <span className="flex items-center gap-1 rounded-md bg-muted px-1.5 py-px text-[11px] text-muted-foreground">
                        <Layers className="size-3" />
                        {t("plans.childrenCount", { count: kids.length })}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

            {col === "todo" && <AddCard onAdd={(title) => addTask(date, null, title)} />}
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
    <div className="mt-auto flex items-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-2.5 transition-colors focus-within:border-brand/50">
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
