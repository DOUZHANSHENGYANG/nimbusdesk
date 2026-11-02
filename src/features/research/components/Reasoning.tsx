import { useEffect, useState, type ReactNode } from "react";
import { BrainCircuit, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 可折叠的「思考 / 过程」面板：运行中自动展开并转圈，结束后可收起。
 * 内容放任意过程卡片。
 */
export function Reasoning({ title = "过程", meta, running = false, defaultOpen = false, children }: {
    title?: string;
    meta?: string;
    running?: boolean;
    defaultOpen?: boolean;
    children: ReactNode;
}) {
    const [open, setOpen] = useState(defaultOpen || running);

    useEffect(() => {
        if (running) setOpen(true);
    }, [running]);

    return <section className="rounded-xl border border-border bg-muted/30">
        <button type="button" onClick={() => setOpen(value => !value)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className={cn("inline-flex size-6 items-center justify-center rounded-lg", running ? "bg-brand/15 text-brand" : "bg-brand/10 text-brand")}>
                {running ? <Loader2 className="size-3.5 animate-spin"/> : <BrainCircuit className="size-3.5"/>}
            </span>
            <span className={cn("text-[11px] font-bold", running ? "text-brand" : "text-foreground")}>{title}</span>
            {meta && <span className="font-mono text-[10px] text-muted-foreground">{meta}</span>}
            <ChevronDown className={cn("ml-auto size-3.5 text-muted-foreground transition-transform", open && "rotate-180")}/>
        </button>
        {open && <div className="space-y-2 px-3 pb-3">{children}</div>}
    </section>;
}
