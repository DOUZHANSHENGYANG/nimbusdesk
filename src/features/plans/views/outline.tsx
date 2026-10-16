import { Fragment, useRef, useState } from "react";
import { Check, ChevronRight, Pencil, Plus, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  childrenOf,
  rangeLabel,
  statusOf,
  subtreeProgress,
  type PlanTask,
} from "@/features/plans/types";
import { doneTitleStyle } from "@/features/plans/views/shared";

/** 兄弟排序：未完成在前、已完成沉底（display 层，不动存储顺序 → 取消勾选自动恢复原位） */
function sortDoneLast(tasks: PlanTask[]): PlanTask[] {
  const active = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  return [...active, ...done];
}
import { useDayTasks, useNow, usePlans } from "@/features/plans/store";
import { StatusButton } from "@/features/plans/views/shared";
import { TimeRangePicker } from "@/features/plans/views/time-range";
import { useModal } from "@/components/shell/modal-host";
import { gsap, useGSAP } from "@/lib/gsap";
import { cn } from "@/lib/utils";

/** 每层缩进（树形引导线间距） */
const INDENT = 20;

/** 大纲视图：Todoist 式多级任务树 —— 顶部快速添加 + 引导线 + 父任务进度 + 完成沉底 */
export function OutlineView({ date }: { date: string }) {
  const { t } = useTranslation();
  const tasks = useDayTasks(date);
  const addTask = usePlans((s) => s.addTask);
  const roots = sortDoneLast(childrenOf(tasks, null));
  const listRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");

  useGSAP(
    () => {
      const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-row]");
      if (rows && rows.length) {
        gsap.from(rows, { autoAlpha: 0, y: 6, duration: 0.26, stagger: 0.02, ease: "power2.out", clearProps: "all" });
      }
    },
    { dependencies: [date, tasks.length], scope: listRef },
  );

  const submit = () => {
    const v = input.trim();
    if (!v) return;
    addTask(date, null, v);
    setInput("");
  };

  return (
    <div className="flex flex-col" ref={listRef}>
      {/* 顶部快速添加（Todoist 式） */}
      <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-2.5 transition-colors focus-within:border-brand/60 focus-within:shadow-[var(--pr-shadow-glow)]">
        <Plus className="size-4 shrink-0 text-brand" strokeWidth={2.4} />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={t("plans.addPlaceholder")}
          className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
        />
      </div>

      {roots.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-muted-foreground">{t("plans.emptyDay")}</p>
      ) : (
        <RowsWithDoneDivider
          list={roots}
          dividerIndent={4}
          label={t("plans.doneGroup")}
          render={(task) => <TaskRow date={date} task={task} depth={0} />}
        />
      )}
    </div>
  );
}

/** 渲染一行列表（根级或子级），已完成后插入分组分隔线 */
function RowsWithDoneDivider({
  list,
  render,
  dividerIndent,
  label,
}: {
  list: PlanTask[];
  render: (task: PlanTask) => React.ReactNode;
  dividerIndent: number;
  label: string;
}) {
  const activeCount = list.filter((t) => !t.done).length;
  return (
    <>
      {list.map((task, idx) => (
        <Fragment key={task.id}>
          {idx === activeCount && activeCount > 0 && activeCount < list.length && (
            <div
              className="flex items-center gap-2 py-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground/70"
              style={{ paddingLeft: dividerIndent }}
            >
              <span className="h-px flex-1 bg-border" />
              {label}
              <span className="h-px flex-1 bg-border" />
            </div>
          )}
          {render(task)}
        </Fragment>
      ))}
    </>
  );
}

function TaskRow({ date, task, depth }: { date: string; task: PlanTask; depth: number }) {
  const { t } = useTranslation();
  const { confirm } = useModal();
  const tasks = useDayTasks(date);
  const now = useNow();
  const addTask = usePlans((s) => s.addTask);
  const updateTask = usePlans((s) => s.updateTask);
  const removeTask = usePlans((s) => s.removeTask);
  const toggleDone = usePlans((s) => s.toggleDone);

  const children = sortDoneLast(childrenOf(tasks, task.id));
  const sub = subtreeProgress(tasks, task.id);
  const status = statusOf(task, date, now);
  const range = rangeLabel(task);
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ title: string; start?: string; end?: string; note: string }>({
    title: "",
    note: "",
  });
  const [childInput, setChildInput] = useState("");

  const startEdit = () => {
    setDraft({
      title: task.title,
      start: task.start,
      end: task.end,
      note: task.note ?? "",
    });
    setEditing(true);
  };

  const saveEdit = () => {
    const title = draft.title.trim();
    if (!title) return;
    updateTask(date, task.id, {
      title,
      start: draft.start,
      end: draft.end,
      note: draft.note.trim() || undefined,
    });
    setEditing(false);
  };

  const addChild = () => {
    const v = childInput.trim();
    if (!v) return;
    addTask(date, task.id, v);
    setChildInput("");
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: t("plans.deleteConfirm"),
      description: task.title,
      danger: true,
    });
    if (ok) removeTask(date, task.id);
  };

  const hasKids = children.length > 0;

  return (
    <div data-row>
      {/* 任务行 */}
      <div
        className={cn(
          "group flex min-h-10 items-center gap-2 rounded-lg py-1 pr-1 transition-colors hover:bg-surface-hover",
          // 进行中：左侧一条品牌色标记，扫一眼就能看到当前该做什么
          status === "doing" && "bg-brand/5 ring-1 ring-inset ring-brand/20",
        )}
        style={{ paddingLeft: 4 }}
      >
        {/* 展开/占位 */}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={cn(
            "grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-transform duration-200",
            hasKids ? "hover:bg-muted hover:text-foreground" : "invisible",
            open && hasKids && "rotate-90",
          )}
        >
          <ChevronRight className="size-4" />
        </button>

        <StatusButton status={status} onToggle={() => toggleDone(date, task.id)} />

        {/* 标题 / 编辑态 */}
        {editing ? (
          <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-lg border border-border bg-card p-2.5">
            {/* 第一行：标题（弹性）+ 时间 + 确认/取消（图标按钮，视觉重量一致） */}
            <div className="flex min-w-0 items-center gap-2">
              <input
                autoFocus
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveEdit();
                  if (e.key === "Escape") setEditing(false);
                }}
                className="min-w-0 flex-1 bg-transparent text-[13px] font-medium outline-none"
                placeholder={t("plans.titleLabel")}
              />
              <TimeRangePicker
                start={draft.start}
                end={draft.end}
                onChange={({ start, end }) => setDraft({ ...draft, start, end })}
              />
              <button
                type="button"
                onClick={saveEdit}
                title={t("common.confirm")}
                aria-label={t("common.confirm")}
                className="grid size-6 shrink-0 place-items-center rounded-md text-brand transition-colors hover:bg-brand/10"
              >
                <Check className="size-4" strokeWidth={2.6} />
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                title={t("common.cancel")}
                aria-label={t("common.cancel")}
                className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* 第二行：备注独占一行，给足横向空间 */}
            <input
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveEdit();
                if (e.key === "Escape") setEditing(false);
              }}
              placeholder={t("plans.noteLabel")}
              className="w-full bg-transparent text-[12px] text-muted-foreground outline-none placeholder:text-muted-foreground/50"
            />
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {/* 第一行：标题靠左、时间靠右（标题过长换行时时间仍停在首行） */}
            <div className="flex min-w-0 items-start gap-2">
              <button
                type="button"
                onClick={startEdit}
                title={t("plans.editTip")}
                className="min-w-0 flex-1 text-left text-[13px] leading-5"
              >
                <span style={doneTitleStyle(task.done)}>
                  {task.title}
                </span>
                {/* 父任务进度徽章 */}
                {sub.total > 0 && (
                  <span
                    className={cn(
                      "ml-2 inline-block rounded-full px-1.5 py-px align-middle text-[10px] font-semibold",
                      sub.done === sub.total
                        ? "bg-success/15 text-success"
                        : "bg-brand/10 text-brand",
                    )}
                  >
                    {sub.done}/{sub.total}
                  </span>
                )}
                {status === "doing" && (
                  <span className="ml-2 inline-block rounded-full bg-brand px-1.5 py-px align-middle text-[10px] font-semibold text-white">
                    {t("plans.status.doing")}
                  </span>
                )}
              </button>

              {range && (
                <span className="shrink-0 font-mono text-[11px] leading-5 text-muted-foreground/80">
                  {range}
                </span>
              )}
            </div>

            {/* 备注：独占一行 */}
            {task.note && (
              <span
                className="min-w-0 truncate text-[11px] text-muted-foreground/70"
                title={task.note}
              >
                {task.note}
              </span>
            )}
          </div>
        )}

        {/* 悬停操作 */}
        {!editing && (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            <RowAction title={t("plans.editTip")} onClick={startEdit}>
              <Pencil className="size-3.5" />
            </RowAction>
            <RowAction title={t("plans.addChild")} onClick={() => setAdding(!adding)}>
              <Plus className="size-4" />
            </RowAction>
            <RowAction title={t("common.confirm")} danger onClick={() => void onDelete()}>
              <Trash2 className="size-3.5" />
            </RowAction>
          </div>
        )}
      </div>

      {/* 添加子任务输入 */}
      {adding && (
        <div
          className="flex items-center gap-2 py-1"
          style={{ paddingLeft: 26 + depth * INDENT }}
        >
          <input
            autoFocus
            value={childInput}
            onChange={(e) => setChildInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addChild();
              if (e.key === "Escape") setAdding(false);
            }}
            onBlur={addChild}
            placeholder={t("plans.addPlaceholder")}
            className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-[12px] outline-none placeholder:text-muted-foreground/50 focus:border-brand/50"
          />
        </div>
      )}

      {/* 子树：缩进 + 竖向引导线（Workflowy 式层级视觉） */}
      {open && hasKids && (
        <div
          className="relative border-l-2 border-border/50"
          style={{ marginLeft: 14 + depth * INDENT }}
        >
          <RowsWithDoneDivider
            list={children}
            dividerIndent={4}
            label={t("plans.doneGroup")}
            render={(child) => <TaskRow date={date} task={child} depth={depth + 1} />}
          />
        </div>
      )}
    </div>
  );
}

function RowAction({
  title,
  danger,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "grid size-6 place-items-center rounded-md text-muted-foreground transition-colors",
        danger ? "hover:bg-destructive/10 hover:text-destructive" : "hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
