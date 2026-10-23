import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { todayStr } from "@/features/plans/types";
import { ProjectSelect, type ItemRecord } from "./forms";
import { itemDeadline, StatusMark } from "./details";
import { useProjectsCopy } from "./copy";
import { useProjects } from "./store";
import { completionRate, groupProgress, needsAttention, recentlyUpdated, statusCounts } from "./overview-core";

/**
 * 总览：一屏把「现在什么状况」摊开——状态分布、迭代进度、需要关注、项目进度、最近改动。
 *
 * 这里刻意不吃状态筛选和搜索（它展示的就是状态分布，先按状态筛再统计会自相矛盾），
 * 但吃范围与迭代，所以卡片里的迭代下拉与页头那行是同一份状态。
 * 每块只回答一个问题，块与块之间不重复：数字块看总量，进度条看比例，列表看具体是哪几条。
 */
export function ProjectsOverview(props: {
  /** 已按范围 + 迭代过滤、并套过历史迭代快照的工作项（含已完成/已取消） */
  items: ItemRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  iterationFilter: string;
  onIterationFilter: (value: string) => void;
  iterationOptions: { value: string; label: string }[];
  /** 点「项目进度」里的一行，把范围收到那一组：项目 id / area:<id> / none */
  onOpenGroup: (key: string) => void;
}) {
  const c = useProjectsCopy(), state = useProjects();
  const today = todayStr();
  const counts = statusCounts(props.items);
  const rate = completionRate(counts);
  const attention = needsAttention(props.items.map(item => ({ ...item, deadline: itemDeadline(item, state.iterations) })), today);
  const areaName = (id: string | null) => id ? state.areas.find(area => area.id === id)?.name ?? c.unclassified : c.unclassified;
  const where = (item: ItemRecord) => item.projectId
    ? state.projects.find(project => project.id === item.projectId)?.name ?? c.noProject
    : areaName(item.areaId);
  const progress = groupProgress(props.items, item => item.projectId ?? (item.areaId ? `area:${item.areaId}` : "none"));
  const groupName = (key: string) => key === "none" ? c.noProject : key.startsWith("area:") ? areaName(key.slice(5)) : state.projects.find(project => project.id === key)?.name ?? c.noProject;
  const recent = recentlyUpdated(props.items, 5);
  const iteration = props.iterationFilter === "current"
    ? state.iterations.find(entry => entry.start <= today && entry.end >= today)
    : props.iterationFilter === "all" || props.iterationFilter === "none" ? undefined : state.iterations.find(entry => entry.id === props.iterationFilter);
  const daysLeft = iteration ? Math.round((Date.parse(iteration.end) - Date.parse(today)) / 86_400_000) : undefined;
  const segments = [
    { key: "todo", count: counts.todo, className: "bg-muted-foreground/45" },
    { key: "doing", count: counts.doing, className: "bg-primary" },
    { key: "done", count: counts.done, className: "bg-emerald-500" },
    { key: "cancelled", count: counts.cancelled, className: "bg-foreground/15" },
  ] as const;
  const barSegments = segments.filter(segment => segment.key !== "todo");

  const itemRow = (item: ItemRecord, date?: string | null, extra?: string, danger?: boolean) => <div key={item.id} data-work-item={item.id} className="flex min-w-0 items-center gap-1">
    <button type="button" onClick={() => props.onSelect(item.id)} aria-pressed={props.selectedId === item.id}
      className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring", props.selectedId === item.id && "bg-accent/60")}>
      <StatusMark status={item.status} className="shrink-0" />
      <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", item.status === "done" && "text-muted-foreground line-through decoration-muted-foreground/40")}>{item.title}</span>
      <span className="max-w-[96px] shrink-0 truncate text-[11px] text-muted-foreground">{where(item)}</span>
      {date && <span className={cn("shrink-0 text-[11px] tabular-nums", danger ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>{shortDate(date)}</span>}
    </button>
    {extra && <span className="shrink-0 pr-1.5 text-[11px] tabular-nums text-muted-foreground">{extra}</span>}
  </div>;

  return <div className="min-h-0 flex-1 overflow-y-auto p-3">
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <Tile id="todo" label={c.todo} value={counts.todo} hint={c.overviewHintBacklog} />
      <Tile id="doing" label={c.doing} value={counts.doing} hint={c.overviewHintDoing} />
      <Tile id="done" label={c.done} value={counts.done} hint={`${rate}% ${c.overviewCompletion}`} />
      <Tile id="overdue" label={c.overdue} value={attention.overdue.length} hint={c.overviewOverdueHint} tone={attention.overdue.length ? "text-amber-700 dark:text-amber-400" : undefined} />
    </div>

    <Card className="mt-2" title={c.overviewIteration} action={<div className="flex shrink-0 items-center gap-2">
      {iteration && <span className="hidden text-[11px] tabular-nums text-muted-foreground sm:inline">{iteration.start} – {iteration.end}{daysLeft !== undefined && daysLeft >= 0 ? ` · ${daysLeft} ${c.overviewDaysToDeadline}` : ""}</span>}
      <div className="w-44"><ProjectSelect label={c.iteration} value={props.iterationFilter} onChange={props.onIterationFilter} options={props.iterationOptions} className="text-xs" /></div>
    </div>}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-[240px] flex-1">
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
            {segments.map(segment => segment.count > 0 && <div key={segment.key} className={segment.className} style={{ width: `${(segment.count / Math.max(1, counts.total)) * 100}%` }} />)}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {segments.map(segment => <span key={segment.key} className="flex items-center gap-1"><span className={cn("size-2 rounded-full", segment.className)} />{c[segment.key]}<span className="tabular-nums text-foreground/80">{segment.count}</span></span>)}
            <span className="tabular-nums text-muted-foreground/80">{counts.total} {c.count}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end justify-center pr-1">
          <span className="text-2xl leading-tight font-semibold tabular-nums">{rate}%</span>
          <span className="text-[11px] text-muted-foreground">{c.overviewCompletion}</span>
        </div>
      </div>
    </Card>

    <div className="mt-2 grid gap-2 lg:grid-cols-2 xl:grid-cols-3">
      <Card title={c.overviewAttention} action={<span className="pr-0.5 text-[11px] tabular-nums text-muted-foreground">{attention.overdue.length + attention.today.length + attention.soon.length}</span>}>
        {!attention.overdue.length && !attention.today.length && !attention.soon.length && <p className="py-1 text-[11.5px] text-muted-foreground">{c.overviewAttentionEmpty}</p>}
        {([["overdue", c.overdue, attention.overdue, true], ["today", c.dueToday, attention.today, true], ["soon", c.overviewSoon, attention.soon, false]] as const).map(([key, label, group, danger]) => group.length > 0 && <div key={key} className="mt-1 first:mt-0">
          <p className="flex items-center gap-1 px-1.5 text-[11px] text-muted-foreground">{label}<span className="tabular-nums">{group.length}</span></p>
          {group.slice(0, 4).map(item => itemRow(item, item.deadline, undefined, danger))}
        </div>)}
      </Card>

      <Card title={c.overviewProjects} action={<span className="pr-0.5 text-[11px] tabular-nums text-muted-foreground">{progress.length}</span>}>
        {!progress.length && <p className="py-1 text-[11.5px] text-muted-foreground">{c.overviewProjectsEmpty}</p>}
        {progress.slice(0, 6).map(row => <button key={row.key} type="button" onClick={() => props.onOpenGroup(row.key)}
          className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
          <span className="min-w-0 flex-1 truncate text-[12.5px]">{groupName(row.key)}</span>
          <span className="flex h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
            {barSegments.map(segment => { const value = row.counts[segment.key]; return value > 0 ? <span key={segment.key} className={segment.className} style={{ width: `${(value / Math.max(1, row.counts.total)) * 100}%` }} /> : null; })}
          </span>
          <span className="w-11 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{row.counts.open}/{row.counts.total}</span>
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" />
        </button>)}
      </Card>

      <Card title={c.overviewRecent} className="lg:col-span-2 xl:col-span-1">
        {!recent.length && <p className="py-1 text-[11.5px] text-muted-foreground">{c.overviewProjectsEmpty}</p>}
        {recent.map(item => itemRow(item, null, shortDate(new Date(item.updatedAt).toISOString().slice(0, 10))))}
      </Card>
    </div>
  </div>;
}

function Tile({ id, label, value, hint, tone }: { id: string; label: string; value: number; hint: string; tone?: string }) {
  return <div data-overview-tile={id} className="rounded-lg border border-border bg-muted/20 px-3 py-2">
    <p className="text-[11px] text-muted-foreground">{label}</p>
    <p data-overview-value className={cn("mt-0.5 text-2xl font-semibold tabular-nums", tone)}>{value}</p>
    <p className="truncate text-[11px] text-muted-foreground/80">{hint}</p>
  </div>;
}

function Card({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={cn("flex min-w-0 flex-col rounded-lg border border-border bg-muted/10 p-2", className)}>
    <header className="mb-1.5 flex min-h-7 items-center justify-between gap-2 px-0.5"><h3 className="text-[11px] font-medium text-muted-foreground">{title}</h3>{action}</header>
    {children}
  </section>;
}

/** 总览里只显示 MM/DD：日期已经由分组标题（逾期/今天/7 天内）说清语义了。 */
function shortDate(day: string): string {
  return day.slice(5).replace("-", "/");
}
