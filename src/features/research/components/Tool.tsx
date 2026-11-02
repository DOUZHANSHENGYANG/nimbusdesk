import { useState, type ReactNode } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToolStatus = "running" | "done" | "error";

/** 一次「工具调用 / 阶段」卡片：图标 + 标题 + 结果摘要 + 可展开详情。 */
export function Tool({ icon, title, subtitle, badge, status = "done", defaultOpen = false, children }: {
    icon: ReactNode;
    title: string;
    subtitle?: string;
    badge?: string;
    status?: ToolStatus;
    defaultOpen?: boolean;
    children?: ReactNode;
}) {
    const [open, setOpen] = useState(defaultOpen);
    const hasBody = Boolean(children);

    return <div className={cn("rounded-lg border bg-card",
        status === "running" ? "border-brand/40"
            : status === "error" ? "border-destructive/40"
                : "border-border")}>
        <button type="button" onClick={() => hasBody && setOpen(value => !value)}
            className={cn("flex w-full items-start gap-2 px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring", hasBody ? "cursor-pointer" : "cursor-default")}>
            <span className={cn("mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md",
                status === "running" ? "bg-brand/10 text-brand"
                    : status === "error" ? "bg-destructive/10 text-destructive"
                        : "bg-muted text-muted-foreground")}>
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                    <span className="truncate text-[11px] font-semibold text-foreground">{title}</span>
                    {badge && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{badge}</span>}
                    {status === "running" && <Loader2 className="size-3 shrink-0 animate-spin text-brand"/>}
                </span>
                {subtitle && <span className="block truncate text-[10px] text-muted-foreground">{subtitle}</span>}
            </span>
            {hasBody && <ChevronDown className={cn("mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}/>}
        </button>
        {open && hasBody && <div className="space-y-1.5 border-t border-border px-2.5 pb-2.5 pt-2">{children}</div>}
    </div>;
}
