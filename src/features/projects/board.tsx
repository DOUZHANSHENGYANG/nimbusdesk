import { useState } from "react";
import { ArrowRightLeft } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { todayStr } from "@/features/plans/types";
import { BOARD_COLUMNS, groupByStatus, nextStatusFor, type BoardColumn } from "./board-core";
import { useProjectsCopy } from "./copy";
import { StatusMark, deadlineLabel, itemDeadline } from "./details";
import { useZenCopy } from "./zentao-copy";
import { useProjects } from "./store";
import type { ItemRecord } from "./forms";

/**
 * 看板视图：一列一个状态，卡片拖到别的列就改状态（写回 updateItem）。
 *
 * 卡片内容与列表行同源——传进来的 items 已经套过「历史迭代快照」并保持列表的排序，
 * 所以同一份筛选切到看板看到的是同一批卡片，只是换了排布。
 * 键盘路径不走拖拽：卡片是可聚焦按钮，回车开详情面板，状态在那里用下拉改（与列表页一致）。
 */
export function ProjectsBoard(props: {
  items: ItemRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 与列表页相同的「已结转」标记（当前看的是旧迭代快照时才有意义） */
  carriedIds: Set<string>;
  statusFilter: string;
  onShowAllStatuses: () => void;
}) {
  const c = useProjectsCopy(), z = useZenCopy(), state = useProjects();
  const today = todayStr();
  const [dragging, setDragging] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<BoardColumn | null>(null);
  const [announced, setAnnounced] = useState("");
  const buckets = groupByStatus(props.items);
  const where = (item: ItemRecord) => state.projects.find(p => p.id === item.projectId)?.name
    ?? state.areas.find(a => a.id === (item.areaId ?? state.projects.find(p => p.id === item.projectId)?.areaId))?.name
    ?? c.noProject;

  function move(item: ItemRecord, target: BoardColumn) {
    const next = nextStatusFor(item.status, target);
    if (!next) return;
    try {
      state.updateItem(item.id, { status: next });
      setAnnounced(`${item.title} · ${c[next]}`);
    } catch { toast.error(c.failed); }
  }

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
      <span>{c.boardHint}</span>
      <span className="flex items-center gap-2"><span className="tabular-nums" aria-live="polite">{props.items.length} {c.count}</span>{props.statusFilter !== "all" && <><span>{c.boardFilterNote}</span><Button variant="link" className="h-auto p-0 text-xs" onClick={props.onShowAllStatuses}>{c.boardShowAll}</Button></>}</span>
    </div>
    <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-3">
      {BOARD_COLUMNS.map(column => <section key={column} aria-label={`${c[column]} · ${buckets[column].length}`} className={cn("flex min-w-[220px] flex-1 basis-60 flex-col rounded-lg border border-border bg-muted/20", overColumn === column && "border-primary/60 bg-primary/5")}
        onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; if (overColumn !== column) setOverColumn(column); }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOverColumn(null); }}
        onDrop={event => {
          event.preventDefault();
          const id = event.dataTransfer.getData("text/plain") || dragging;
          const item = props.items.find(entry => entry.id === id);
          if (item) move(item, column);
          setDragging(null); setOverColumn(null);
        }}>
        <header className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border px-2.5 text-xs font-medium text-muted-foreground"><StatusMark status={column} />{c[column]}<span className="ml-auto tabular-nums">{buckets[column].length}</span></header>
        <div role="list" className="min-h-[72px] flex-1 space-y-1.5 overflow-y-auto p-1.5">
          {buckets[column].map(item => {
            const deadline = itemDeadline(item, state.iterations), closed = item.status === "done" || item.status === "cancelled", overdue = Boolean(deadline && deadline < today && !closed);
            return <div key={item.id} role="listitem" data-work-item={item.id} draggable
              onDragStart={event => { setDragging(item.id); event.dataTransfer.setData("text/plain", item.id); event.dataTransfer.effectAllowed = "move"; }}
              onDragEnd={() => { setDragging(null); setOverColumn(null); }}
              className={cn("group rounded-md border border-border bg-background p-1.5 shadow-xs", dragging === item.id && "opacity-40")}>
              <div className="flex items-start gap-1">
                <Button variant="ghost" size="icon-xs" className="mt-0.5 shrink-0" disabled={Boolean(item.mergedIntoId)} aria-label={`${closed ? c.restoreItem : c.completed} · ${item.title}`} title={closed ? c.restoreItem : c.completed} onClick={() => state.updateItem(item.id, { status: closed ? "todo" : "done" })}><StatusMark status={item.status} /></Button>
                <button type="button" aria-pressed={props.selectedId === item.id} onClick={() => props.onSelect(item.id)} className={cn("min-w-0 flex-1 rounded px-0.5 py-0.5 text-left text-[13px] leading-snug outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring", closed && "text-muted-foreground", item.status === "done" && "line-through decoration-muted-foreground/40")}>{item.title}{item.mergedIntoId ? ` · ${z.merged}` : ""}</button>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-6 text-[11px] text-muted-foreground">
                <span className="max-w-[132px] truncate">{where(item)}</span>
                {props.carriedIds.has(item.id) && <span className="flex items-center gap-0.5"><ArrowRightLeft className="size-3" />{c.carried}</span>}
                {deadline && <span className={cn("tabular-nums", overdue && "text-amber-700 dark:text-amber-400")}>{deadlineLabel(deadline, c)}</span>}
              </div>
            </div>;
          })}
          {!buckets[column].length && <p className="px-1.5 py-2 text-[11.5px] text-muted-foreground/70">{c.boardEmpty}</p>}
        </div>
      </section>)}
    </div>
    <p className="sr-only" role="status" aria-live="polite">{announced}</p>
  </div>;
}
