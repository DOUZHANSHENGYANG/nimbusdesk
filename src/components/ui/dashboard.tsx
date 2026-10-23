import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 看板式页面的两块“积木”：数字格与卡片。
 *
 * 项目页总览和首页概览是同一套版式（顶上一排数字 + 下面若干只回答一个问题的卡片），
 * 所以样式只写在这里一份：改间距、圆角、字号只改这一个文件，两页同时跟着走。
 */

export function StatTile({ id, label, value, hint, tone }: {
  /** 给测试与调试用的稳定标识（不参与显示） */
  id: string;
  label: string;
  value: number | string;
  hint?: string;
  tone?: string;
}) {
  return <div data-stat={id} className="rounded-lg border border-border bg-muted/20 px-3 py-2">
    <p className="text-[11px] text-muted-foreground">{label}</p>
    <p data-stat-value className={cn("mt-0.5 text-2xl font-semibold tabular-nums", tone)}>{value}</p>
    {hint && <p className="truncate text-[11px] text-muted-foreground/80">{hint}</p>}
  </div>;
}

export function DashboardCard({ title, action, children, className }: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return <section className={cn("flex min-w-0 flex-col rounded-lg border border-border bg-muted/10 p-2", className)}>
    <header className="mb-1.5 flex min-h-7 items-center justify-between gap-2 px-0.5"><h3 className="truncate text-[11px] font-medium text-muted-foreground">{title}</h3>{action}</header>
    {children}
  </section>;
}

/** 分段条：一段一个状态，宽度按占比。空段不渲染，免得出现 0 宽的边色。 */
export function SegmentBar({ segments, total, className }: {
  segments: readonly { key: string; count: number; className: string }[];
  total: number;
  className?: string;
}) {
  return <span className={cn("flex overflow-hidden rounded-full bg-muted", className ?? "h-2 w-full")}>
    {segments.map(segment => segment.count > 0
      ? <span key={segment.key} className={segment.className} style={{ width: `${(segment.count / Math.max(1, total)) * 100}%` }} />
      : null)}
  </span>;
}
