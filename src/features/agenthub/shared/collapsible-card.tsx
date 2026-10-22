import { ChevronRight, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 可折叠卡片：标题行整行可点，箭头指示展开状态，右侧可放摘要/操作（收起时也看得到）。
 */
export function CollapsibleCard({
  icon: Icon,
  title,
  summary,
  actions,
  children,
  defaultOpen = true,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  /** 收起时显示的摘要 */
  summary?: ReactNode;
  /** 标题行右侧的操作区（不触发折叠） */
  actions?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={cn("rounded-xl border border-border bg-card", className)}>
      <div className="flex items-center gap-1.5 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none"
        >
          <ChevronRight className={cn("size-3.5 shrink-0 text-ink-3 transition-transform", open && "rotate-90")} />
          {Icon ? <Icon className="size-3.5 shrink-0 text-ink-3" /> : null}
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-ink-3">{title}</span>
          {!open && summary ? <span className="min-w-0 flex-1 truncate text-[11px] text-ink-3">{summary}</span> : null}
        </button>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {open ? <div className="px-4 pb-4">{children}</div> : null}
    </div>
  );
}
