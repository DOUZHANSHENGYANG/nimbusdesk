import { Check, Circle, CircleDot } from "lucide-react";
import { childrenOf, type PlanTask, type TaskStatus } from "@/features/plans/types";
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
            ? "border-brand bg-brand text-white"
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

/** 只读树（归档浏览/预览用） */
export function ReadOnlyTree({ tasks, parentId = null, depth = 0 }: {
  tasks: PlanTask[];
  parentId?: string | null;
  depth?: number;
}) {
  const kids = childrenOf(tasks, parentId);
  if (kids.length === 0) return null;
  return (
    <div className="flex flex-col">
      {kids.map((task) => (
        <div key={task.id}>
          <div
            className="group flex min-h-8 items-center gap-2 rounded-md py-1 pr-2"
            style={{ paddingLeft: 10 + depth * 18 }}
          >
            <StatusButton status={task.status} readOnly />
            <span
              className="truncate text-[13px]"
              style={doneTitleStyle(task.status === "done")}
            >
              {task.title}
            </span>
            {task.time && (
              <span className="shrink-0 rounded-md bg-muted px-1.5 py-px font-mono text-[11px] text-muted-foreground">
                {task.time}
              </span>
            )}
            {task.note && (
              <span className="shrink-0 text-[11px] text-muted-foreground/70" title={task.note}>
                ≡
              </span>
            )}
          </div>
          <ReadOnlyTree tasks={tasks} parentId={task.id} depth={depth + 1} />
        </div>
      ))}
    </div>
  );
}
