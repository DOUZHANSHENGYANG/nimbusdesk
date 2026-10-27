import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  childrenOf,
  rangeLabel,
  shouldSplitPaste,
  splitPastedLines,
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
import { gsap, useGSAP } from "@/lib/gsap";
import { cn } from "@/lib/utils";
import { TaskLinkBadge } from "@/features/plans/views/task-link";
import { toast } from "sonner";
import { TaskAttachments } from "@/features/plans/attachments";
import { PlanBinding } from "@/features/projects/plan-binding";
import { TaskDetail } from "@/features/plans/views/task-detail";

/** 每层缩进（树形引导线间距） */
const INDENT = 20;

/** 大纲视图：Todoist 式多级任务树 —— 顶部快速添加 + 引导线 + 父任务进度 + 完成沉底 */
export function OutlineView({ date, searchTaskId, searchToken }: { date: string; searchTaskId?: string; searchToken?: string }) {
  const { t } = useTranslation();
  const tasks = useDayTasks(date);
  const addTask = usePlans((s) => s.addTask);
  const addTasks = usePlans((s) => s.addTasks);
  const roots = sortDoneLast(childrenOf(tasks, null));
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState("");
  const revealIds = useMemo(() => {
    const result = new Set<string>();
    let task = tasks.find(item => item.id === searchTaskId);
    while (task && !result.has(task.id)) {
      result.add(task.id);
      const parentId = task.parentId;
      task = parentId ? tasks.find(item => item.id === parentId) : undefined;
    }
    return result;
  }, [tasks, searchTaskId]);
  useEffect(() => {
    if (!searchTaskId) return;
    let inner = 0;
    const frame = requestAnimationFrame(() => { inner = requestAnimationFrame(() => {
      Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-search-task-id]") ?? []).find(row => row.dataset.searchTaskId === searchTaskId)?.scrollIntoView({ block: "center", behavior: "instant" });
    }); });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(inner); };
  }, [searchTaskId, searchToken, tasks]);

  useGSAP(
    () => {
      const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-row]");
      if (rows && rows.length) {
        gsap.from(rows, { autoAlpha: 0, y: 6, duration: 0.26, stagger: 0.02, ease: "power2.out", clearProps: "all" });
      }
    },
    { dependencies: [date, tasks.length], scope: listRef },
  );

  /*
   * 提交：含换行时走批量拆分。
   * 单行输入（绝大多数情况）仍走 addTask —— 两条路径各自保持简单，
   * 不为了「统一」把常见情况也塞进批量逻辑（那会多一次数组分配）。
   */
  const submit = () => {
    const v = input.trim();
    if (!v) return;
    if (shouldSplitPaste(v)) {
      const lines = splitPastedLines(v);
      if (lines.length > 1) {
        addTasks(date, null, lines);
        toast.success(t("plans.pasteSplit", { count: lines.length }));
        setInput("");
        return;
      }
    }
    addTask(date, null, v);
    setInput("");
  };

  return (
    <div className="flex flex-col" ref={listRef}>
      {/* 顶部快速添加（Todoist 式） */}
      <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-2.5 transition-colors focus-within:border-brand/60 focus-within:shadow-[var(--pr-shadow-glow)]">
        <Plus className="size-4 shrink-0 text-brand" strokeWidth={2.4} />
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={t("plans.addPlaceholder")}
          className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
        />
      </div>

      {roots.length === 0 ? (
        /* 空状态本身就是入口：点一下光标就落到上面那个输入框，不用先找它在哪 */
        <button
          type="button"
          onClick={() => inputRef.current?.focus()}
          className="py-8 text-center text-[13px] text-muted-foreground transition-colors hover:text-brand"
        >
          {t("plans.emptyDay")}
        </button>
      ) : (
        <RowsWithDoneDivider
          list={roots}
          dividerIndent={4}
          label={t("plans.doneGroup")}
          render={(task) => <TaskRow date={date} task={task} depth={0} searchTaskId={searchTaskId} revealIds={revealIds} searchToken={searchToken} />}
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

/**
 * 一行任务。
 *
 * 行上只留「这一条是什么」：状态、标题、进度、备注、时间、关联、附件、项目。
 * 一切「改这一条」的动作都收进 TaskDetail 浮层 —— 行不再变高变矮，
 * 也不再需要在行里判断「点到行外算不算保存」。
 */
function TaskRow({ date, task, depth, searchTaskId, revealIds, searchToken }: { date: string; task: PlanTask; depth: number; searchTaskId?: string; revealIds: Set<string>; searchToken?: string }) {
  const { t } = useTranslation();
  const tasks = useDayTasks(date);
  const now = useNow();
  const updateTask = usePlans((s) => s.updateTask);
  const toggleDone = usePlans((s) => s.toggleDone);

  const children = sortDoneLast(childrenOf(tasks, task.id));
  const sub = subtreeProgress(tasks, task.id);
  const status = statusOf(task, date, now);
  const range = rangeLabel(task);
  const [open, setOpen] = useState(true);
  useEffect(() => { if (revealIds.has(task.id)) setOpen(true); }, [revealIds, task.id, searchToken]);

  const hasKids = children.length > 0;

  return (
    <div data-row>
      <div
        data-search-task-id={task.id}
        className={cn(
          "group flex min-h-10 items-center gap-2 rounded-lg py-1 pr-1 transition-colors hover:bg-surface-hover",
          // 进行中：左侧一条品牌色标记，扫一眼就能看到当前该做什么
          status === "doing" && "bg-brand/5 ring-1 ring-inset ring-brand/20",
          task.id === searchTaskId && "bg-brand/10 ring-1 ring-inset ring-brand/50",
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

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* 第一行：标题靠左、时间靠右（标题过长换行时时间仍停在首行） */}
          <div className="flex min-w-0 items-start gap-2">
            <TaskDetail
              date={date}
              task={task}
              trigger={
                <button
                  type="button"
                  title={t("plans.openDetail")}
                  className="min-w-0 flex-1 rounded text-left text-[13px] leading-5"
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
              }
            />

            {task.link && (
              <TaskLinkBadge
                link={task.link}
                onRemove={() => updateTask(date, task.id, { link: undefined })}
              />
            )}

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

        {/* 附件与项目关联留在行上：它们描述「这一条是什么」，不是动作 */}
        <div className="flex shrink-0 items-center gap-0.5">
          <PlanBinding date={date} task={task} />
          <TaskAttachments date={date} task={task} />
        </div>
      </div>

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
            render={(child) => <TaskRow date={date} task={child} depth={depth + 1} searchTaskId={searchTaskId} revealIds={revealIds} searchToken={searchToken} />}
          />
        </div>
      )}
    </div>
  );
}
