import { useMemo, type ReactNode } from "react";
import { useProjectsCopy } from "./copy";
import { useProjects } from "./store";
import { todayStr } from "@/features/plans/types";
import { burndown, cfd, ganttRows, rangeDays, velocity } from "./charts-core";

/**
 * 四张图共用一份每日快照：甘特看排期，燃尽看剩余点数，累积流看积压，速率看每个迭代干完多少。
 * 不引图表库：甘特是 DOM 条，其余是内联 SVG，横轴永远按天等比，不画假数据。
 */
export function ProjectCharts({ projectId }: { projectId: string }) {
  const c = useProjectsCopy(), state = useProjects();
  const today = todayStr();
  const snapshots = state.snapshots ?? [];
  const project = state.projects.find(entry => entry.id === projectId);
  const rows = useMemo(() => ganttRows(state.items.filter(item => item.projectId === projectId), state.iterations, today), [state.items, state.iterations, projectId, today]);
  const last = [...snapshots].filter(entry => entry.projectId === projectId).at(-1)?.date ?? today;
  const first = snapshots.filter(entry => entry.projectId === projectId)[0]?.date ?? today;
  const burn = burndown(snapshots, projectId, first, last);
  const flow = cfd(snapshots, projectId, first, last);
  const bars = velocity(snapshots, projectId, state.iterations);
  // 一天的历史画不出走势：三张图共用一句说明，别在三个卡片里各说一遍。
  const thin = new Set(snapshots.filter(entry => entry.projectId === projectId).map(entry => entry.date)).size < 2;

  const card = (title: string, body: ReactNode, hint?: string | null) => <section className="rounded-lg border border-border p-3">
    <h2 className="mb-2 flex items-center justify-between text-[11px] font-medium text-muted-foreground"><span>{title}</span>{hint && <span className="tabular-nums">{hint}</span>}</h2>
    {body}
  </section>;

  // 甘特：整段排期按天等比铺开，条的位置就是起止，颜色区分状态。
  const span = rows.length ? { from: rows.reduce((min, row) => row.start < min ? row.start : min, rows[0].start), to: rows.reduce((max, row) => row.end > max ? row.end : max, rows[0].end) } : null;
  const ganttDays = span ? rangeDays(span.from, span.to) : [];
  const tone: Record<string, string> = { done: "bg-primary", doing: "bg-primary/55", overdue: "bg-amber-500", todo: "bg-muted-foreground/35" };

  return <div className="grid gap-3 p-4 xl:grid-cols-2">
    {card(c.chartsGantt, rows.length && span ? <div className="space-y-1">
      {rows.slice(0, 40).map(row => {
        const left = (rangeDays(span.from, row.start).length - 1) / Math.max(1, ganttDays.length - 1) * 100;
        const width = Math.max(2, (rangeDays(row.start, row.end).length) / Math.max(1, ganttDays.length) * 100);
        return <div key={row.id} className="flex items-center gap-2">
          <span className="w-32 shrink-0 truncate text-[11px]" style={{ paddingLeft: row.depth * 10 }} title={row.title}>{row.title}</span>
          <span className="relative h-2.5 min-w-0 flex-1 rounded-full bg-foreground/10">
            <span className={`absolute inset-y-0 rounded-full ${tone[row.tone]}`} style={{ left: `${left}%`, width: `${width}%` }} />
          </span>
          <span className="w-14 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">{row.end.slice(5)}</span>
        </div>;
      })}
      <p className="pt-1 text-[10px] text-muted-foreground">{span.from} → {span.to}</p>
    </div> : <p className="py-3 text-[11px] text-muted-foreground">{c.chartsGanttEmpty}</p>, `${rows.length}`)}

    {thin
      ? <p className="rounded-lg border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground xl:col-span-2">{c.chartsEmpty}</p>
      : <>
        {card(c.chartsBurndown, <Line points={burn} />, burn[0] ? `${burn[0].remaining} ${c.chartsPoints}` : null)}
        {card(c.chartsCfd, <Flow points={flow} />, `${flow.at(-1)?.done ?? 0} / ${(flow.at(-1)?.done ?? 0) + (flow.at(-1)?.doing ?? 0) + (flow.at(-1)?.todo ?? 0)}`)}
        {card(c.chartsVelocity, <div className="flex h-24 items-end gap-1.5">
          {bars.slice(-12).map(bar => {
            const max = Math.max(...bars.map(entry => entry.donePoints), 1);
            return <span key={bar.id} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${bar.name} · ${bar.donePoints} ${c.chartsPoints}`}>
              <span className="w-full rounded-t bg-primary/70" style={{ height: `${Math.max(4, bar.donePoints / max * 76)}px` }} />
              <span className="w-full truncate text-center text-[10px] text-muted-foreground">{bar.name}</span>
            </span>;
          })}
        </div>, bars.length ? `${Math.round(bars.reduce((sum, bar) => sum + bar.donePoints, 0) / bars.length * 10) / 10} ${c.chartsPoints}` : null)}
      </>}

    {project && <p className="col-span-full text-[10px] text-muted-foreground">{project.name} · {snapshots.filter(entry => entry.projectId === projectId).length} {c.chartsPoints}</p>}
  </div>;
}

/** 燃尽：实际剩余 + 理想直线。date 轴等距，缺天的位置由 charts-core 沿用前一天。 */
function Line({ points }: { points: { remaining: number; ideal: number }[] }) {
  const max = Math.max(...points.map(point => Math.max(point.remaining, point.ideal)), 1);
  const path = (pick: (point: { remaining: number; ideal: number }) => number) => points.map((point, index) => `${index === 0 ? "M" : "L"}${(index / Math.max(1, points.length - 1) * 100).toFixed(2)},${(36 - pick(point) / max * 32).toFixed(2)}`).join(" ");
  return <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-24 w-full text-primary" role="img" aria-label="burndown">
    <path d={path(point => point.ideal)} fill="none" stroke="currentColor" strokeOpacity="0.3" strokeDasharray="2 2" strokeWidth="0.7" vectorEffect="non-scaling-stroke" />
    <path d={path(point => point.remaining)} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
  </svg>;
}

/** 累积流：每天一条堆叠柱，绿=已完成，蓝=进行中，灰=待办。 */
function Flow({ points }: { points: { todo: number; doing: number; done: number }[] }) {
  const max = Math.max(...points.map(point => point.todo + point.doing + point.done), 1);
  // 一天一格，但最宽 6%：只有一天历史时不该糊满整块。
  const width = Math.min(6, 100 / Math.max(1, points.length));
  return <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-24 w-full" role="img" aria-label="cumulative flow">
    {points.map((point, index) => {
      const total = point.todo + point.doing + point.done;
      const h = total / max * 36;
      const x = index * (100 / Math.max(1, points.length));
      const doneH = h * (point.done / Math.max(1, total));
      const doingH = h * (point.doing / Math.max(1, total));
      const todoH = h - doneH - doingH;
      return <g key={index}>
        <rect x={x} y={36 - doneH} width={width} height={doneH} className="fill-primary" />
        <rect x={x} y={36 - doneH - doingH} width={width} height={doingH} className="fill-primary/55" />
        <rect x={x} y={36 - h} width={width} height={todoH} className="fill-foreground/20" />
      </g>;
    })}
  </svg>;
}
