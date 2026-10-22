import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/ahub/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 py-20 text-center", className)}>
      <div className="grid size-14 place-items-center rounded-2xl border border-border bg-surface text-ink-3 shadow-sm">
        <Icon className="size-6" />
      </div>
      <div className="text-sm font-medium text-foreground">{title}</div>
      {hint ? <div className="max-w-sm text-xs leading-relaxed text-ink-3">{hint}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
