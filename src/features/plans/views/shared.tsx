import { Check, Circle, CircleDot } from "lucide-react";
import {
  childrenOf,
  rangeLabel,
  statusOf,
  type PlanTask,
  type TaskStatus,
} from "@/features/plans/types";
import { cn } from "@/lib/utils";
/** 状态圆钮：todo 空圈 / doing 半点 / done 实心勾。点击在 todo↔done 间切换 */
export function StatusButton({
  status,
  onToggle,
  readOnly,
  className,
}: {
  status: TaskStatus;
  onToggle?: () => void;
  readOnly?: boolean;
  className?: string;
}) {
  const done = status === "done";
  return (
    <button
      type="button"
      disabled={readOnly}
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.();
      }}
      title={status}
      className={cn(
        "grid size-6 shrink-0 cursor-pointer place-items-center rounded-full transition-all duration-200",
        readOnly && "cursor-default",
        className,
      )}
    >
      <span
        className={cn(
          "grid size-[18px] place-items-center rounded-full border-2 transition-colors duration-200",
          done
            ? // 完成态用中性灰：一整组完成项连成一片时，品牌蓝会把它们喊成「还要注意」
              "border-muted-foreground/50 bg-muted-foreground/50 text-background"
            : status === "doing"
              ? "border-brand text-brand"
              : "border-muted-foreground/40 text-transparent hover:border-brand hover:text-brand/40",
        )}
      >
        {done ? (
          <Check className="size-3" strokeWidth={3.5} />
        ) : status === "doing" ? (
          <CircleDot className="size-3" strokeWidth={2.4} />
        ) : (
          <Circle className="size-2.5" strokeWidth={0} />
        )}
      </span>
    </button>
  );
}

/** 已完成标题样式：内联 style 硬保证划线（不依赖工具类生成） */
export function doneTitleStyle(done: boolean): React.CSSProperties | undefined {
  return done
    ? {
        textDecoration: "line-through",
        textDecorationColor: "color-mix(in oklch, var(--muted-foreground) 55%, transparent)",
        color: "var(--muted-foreground)",
      }
    : undefined;
}

/**
 * 只读树（归档浏览/预览用）。
 * - date 用于推导「进行中」
 * - only 给定时只渲染这些 id 的子树（归档关键词筛选用），
 *   未给定则渲染整棵树
 */
export function ReadOnlyTree({ tasks, date, only, parentId = null, depth = 0, searchTaskId }: {
  tasks: PlanTask[];
  date: string;
  only?: Set<string>;
  parentId?: string | null;
  depth?: number;
  searchTaskId?: string;
}) {
  const kids = childrenOf(tasks, parentId).filter((t) => !only || only.has(t.id));
  if (kids.length === 0) return null;
  return (
    <div className="flex flex-col">
      {kids.map((task) => (
        <div key={task.id}>
          <div
            data-search-task-id={task.id}
            className={cn("group flex min-h-8 items-center gap-2 rounded-md py-1 pr-2", task.id === searchTaskId && "bg-brand/10 ring-1 ring-inset ring-brand/50")}
            style={{ paddingLeft: 10 + depth * 18 }}
          >
            <StatusButton status={statusOf(task, date)} readOnly />
            <span
              className="truncate text-[13px]"
              style={doneTitleStyle(task.done)}
            >
              {task.title}
            </span>
            {rangeLabel(task) && (
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {rangeLabel(task)}
              </span>
            )}
            {task.note && (
              <span className="shrink-0 text-[11px] text-muted-foreground/70" title={task.note}>
                ≡
              </span>
            )}

          </div>
          <ReadOnlyTree tasks={tasks} date={date} only={only} parentId={task.id} depth={depth + 1} searchTaskId={searchTaskId} />
        </div>
      ))}
    </div>
  );
}
