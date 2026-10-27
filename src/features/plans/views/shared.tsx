import { Check, Circle, CircleDot } from "lucide-react";
import { useTranslation } from "react-i18next";
import { lunarLabel } from "@/lib/lunar";
import {
  childrenOf,
  eventColorIndex,
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
 * 日历事件色的类名表。
 *
 * Tailwind 只认源码里**字面出现**的类名，所以这里必须是写死的字符串，
 * 不能拼 `bg-event-${n}`。顺序与 types.ts 的 `EVENT_COLORS` 一一对应。
 *
 * 淡底 + 同色文字（与「已完成/总数」那个 `bg-success/15 text-success` 徽章同一套写法）。
 * 不要描边 —— 一排带框的小药丸读起来又碎又廉价；淡底加同色字已经够分得清是哪一条线。
 * 「进行中」不在这里：它固定用品牌蓝实心，那是「现在」的强信号，不该被身份色顶掉。
 */
const EVENT_TINT = [
  "bg-event-1/15 text-event-1",
  "bg-event-2/15 text-event-2",
  "bg-event-3/15 text-event-3",
  "bg-event-4/15 text-event-4",
  "bg-event-5/15 text-event-5",
];

/** 任务在日历里的事件色类名（底色 + 描边）。颜色由 `eventColorIndex` 决定 */
export function eventTint(task: Pick<PlanTask, "id" | "workItemId">): string {
  return EVENT_TINT[eventColorIndex(task)];
}

/**
 * 农历 / 节气 / 节日的小标签，没到日子或不是中文界面就返回 null（调用方不占位）。
 *
 * 英文界面不渲染：这套名字（廿三、立春、中元节）是中文的，翻过去没有意义。
 * 三档深浅都取自对比度闸门覆盖过的 token：节日用红（中文日历惯例）、节气用正文色、
 * 普通农历日最弱 —— 于是「这天为什么特殊」不用读字也能看出来。
 */
export function LunarText({ date, className }: { date: string; className?: string }) {
  const { i18n } = useTranslation();
  if (!i18n.language.startsWith("zh")) return null;
  const label = lunarLabel(date);
  if (!label) return null;
  return (
    <span
      data-lunar
      className={cn(
        "truncate leading-none",
        label.kind === "festival"
          ? "text-destructive"
          : label.kind === "term"
            ? "text-foreground"
            : "text-muted-foreground",
        className,
      )}
    >
      {label.text}
    </span>
  );
}

/**
 * 只读树（归档浏览/预览用）。 * - date 用于推导「进行中」
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
