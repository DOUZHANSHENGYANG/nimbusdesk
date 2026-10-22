import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 工具箱统一空态：图标 + 一句标题 + 一句提示 +（可选）一个动作。
 *
 * 源侧各页面此前各写一套空态（图标大小、留白都不一致），收敛成一个组件之后
 * 「没有条目」和「没有匹配」就能长得一样。
 */
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
