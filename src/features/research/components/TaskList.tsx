import { Check, Circle, Loader2 } from "lucide-react";

export type TaskStatus = "pending" | "running" | "done" | "error";

export interface TaskItem {
    id: string;
    label: string;
    desc?: string;
    status: TaskStatus;
    meta?: string;
}

/** 阶段清单（规划 → 检索 → 抓正文 → 抽证据 → 合成），显示当前跑到哪一步。 */
export function TaskList({ items }: { items: TaskItem[] }) {
    return <ol className="space-y-1">
        {items.map((item, index) => <li key={item.id} className="flex items-start gap-2 px-1 py-1">
            <span className="mt-0.5 shrink-0">
                {item.status === "done" ? (
                    <span className="inline-flex size-4 items-center justify-center rounded-full bg-success/15 text-success"><Check className="size-2.5"/></span>
                ) : item.status === "running" ? (
                    <Loader2 className="size-4 animate-spin text-brand"/>
                ) : item.status === "error" ? (
                    <span className="inline-flex size-4 items-center justify-center rounded-full bg-destructive/15 text-[10px] font-bold text-destructive">!</span>
                ) : (
                    <Circle className="size-4 text-muted-foreground/40"/>
                )}
            </span>
            <span className="min-w-0 flex-1">
                <span className={item.status === "pending" ? "block text-[11px] text-muted-foreground"
                    : item.status === "running" ? "block text-[11px] font-semibold text-foreground"
                        : "block text-[11px] font-semibold text-foreground"}>
                    {index + 1}. {item.label}
                </span>
                {item.desc && <span className="block text-[10px] leading-4 text-muted-foreground">{item.desc}</span>}
            </span>
            {item.meta && <span className="mt-0.5 shrink-0 font-mono text-[10px] text-muted-foreground">{item.meta}</span>}
        </li>)}
    </ol>;
}
