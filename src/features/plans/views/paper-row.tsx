import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { RiCheckLine, RiAddLine, RiEditLine, RiCloseLine } from "@remixicon/react";
import { statusOf, type PlanTask } from "@/features/plans/types";
import { TaskLinkPicker, TaskLinkStatic } from "@/features/plans/views/task-link";
import { usePlans } from "@/features/plans/store";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp, ChevronDown, GripVertical, Paperclip, Trash2 } from "lucide-react";
import { TimeRangePicker } from "./time-range";
import { TaskAttachments } from "@/features/plans/attachments";
import { PlanBinding } from "@/features/projects/plan-binding";
import { usePlanCopy } from "@/features/plans/copy";

/**
 * 纸片系列（桌面纸片 / 贴边胶囊预览卡）共用的一行任务。
 *
 * 抽出来的原因很实际：胶囊预览卡要复用完全一样的行，而它住在 paper.tsx 里的话，
 * capsule.tsx 就得反过来 import paper.tsx —— 而 paper.tsx 又要 import capsule.tsx，
 * 成了循环依赖。行本身与窗口无关，独立成文件是唯一干净的解。
 */
export function PaperRow({
  date,
  task,
  now,
  depth = 0,
  editable = true,
  onToggle,
  onEdit,
  onAddChild,
  onTimeChange,
  onDetailsChange,
  onDelete,
  selected,
  onSelect,
  searchMatch,
  reorder,
  active = true,
}: {
  date: string;
  task: PlanTask;
  now: Date;
  /** 子任务缩进层级 */
  depth?: number;
  /** 预览卡里关掉改名：预览是「扫一眼 + 勾一下」，不是编辑场所 */
  editable?: boolean;
  onToggle: () => void;
  onEdit: (title: string) => void;
  onAddChild?: (title: string) => void;
  onTimeChange?: (time: { start?: string; end?: string }) => void;
  onDetailsChange?: (open: boolean) => void;
  onDelete?: () => void;
  selected?: boolean;
  onSelect?: (shift: boolean) => void;
  searchMatch?: "match" | "current";
  reorder?: {
    active: boolean;
    position?: "before" | "after";
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    onStart: (event: DragEvent<HTMLElement>) => void;
    onEnd: () => void;
    onOver: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
  /** Hidden edge cards release every local interaction hold. Normal papers stay active. */
  active?: boolean;
}) {
  const copy = usePlanCopy();
  const status = statusOf(task, date, now);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const detailsChanged = useRef(onDetailsChange);
  detailsChanged.current = onDetailsChange;
  useEffect(() => () => detailsChanged.current?.(false), []);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [adding, setAdding] = useState(false);
  const [childTitle, setChildTitle] = useState("");
  const titleRef = useRef<HTMLSpanElement>(null);
  const [canFold, setCanFold] = useState(false);
  const [textExpanded, setTextExpanded] = useState(false);
  useEffect(() => {
    const title = titleRef.current;
    if (!title) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(title).lineHeight) || 18;
      setCanFold(title.scrollHeight > lineHeight * 2 + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(title);
    return () => observer.disconnect();
  }, [task.title, editing]);
  useEffect(() => { if (active && searchMatch) setTextExpanded(true); }, [active, searchMatch]);
  useEffect(() => {
    if (active) return;
    setDetailsOpen(false); setEditing(false); setAdding(false);
    setTextExpanded(false);
    detailsChanged.current?.(false);
  }, [active]);

  const addChild = () => {
    const title = childTitle.trim();
    if (!title) return;
    onAddChild?.(title);
    setChildTitle("");
  };

  const commit = () => {
    const v = draft.trim();
    if (v && v !== task.title) onEdit(v);
    else setDraft(task.title);
    setEditing(false);
  };

  return (
    <div
      data-paper-task={task.id}
      onDragOver={reorder?.onOver}
      onDrop={reorder?.onDrop}
      style={{ paddingLeft: 6 + depth * 13 }}
      className={cn(
        "daily-paper-row group flex min-h-7 flex-wrap items-start gap-x-1.5 rounded-md py-1 pr-1.5 transition-colors",
        status === "doing" && "bg-brand/5 ring-1 ring-inset ring-brand/20",
        selected && "bg-brand/10 ring-1 ring-inset ring-brand/40",
        searchMatch === "match" && "bg-amber-500/10",
        searchMatch === "current" && "ring-2 ring-inset ring-brand",
        reorder?.active && "opacity-50",
        reorder?.position === "before" && "border-t-2 border-brand",
        reorder?.position === "after" && "border-b-2 border-brand",
      )}
    >
      {onSelect && <button type="button" role="checkbox" aria-checked={!!selected} aria-label={`${copy.select}: ${task.title}`}
        onClick={(event) => onSelect(event.shiftKey)}
        className="grid size-6 shrink-0 place-items-center rounded hover:bg-brand/10 focus-visible:ring-2 focus-visible:ring-brand">
        <span className={cn("grid size-3.5 place-items-center rounded-sm border", selected ? "border-brand bg-brand text-white" : "border-muted-foreground/50")}>{selected && <RiCheckLine size={11}/>}</span>
      </button>}
      <button
        type="button"
        role="checkbox"
        aria-checked={task.done}
        onClick={onToggle}
        aria-label={task.title}
        className="grid size-6 shrink-0 place-items-center rounded focus-visible:ring-2 focus-visible:ring-brand"
      >
        <span
          className={cn(
            "grid size-3.5 place-items-center rounded-[4px] border transition-colors",
            task.done
              ? "border-brand bg-brand text-white"
              : status === "doing"
                ? "border-brand"
                : "border-muted-foreground/40 hover:border-brand",
          )}
        >
          {task.done && <RiCheckLine className="size-2.5" />}
        </span>
      </button>

      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commit(); }
            if (e.key === "Escape" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w")) {
              e.preventDefault(); e.stopPropagation();
              setDraft(task.title);
              setEditing(false);
            }
          }}
          className="min-w-0 flex-1 rounded border border-brand/50 bg-card px-1 text-[12px] outline-none"
          aria-label={copy.edit}
        />
      ) : (
        <div className="min-w-0 flex-1">
          <span
            ref={titleRef}
            onDoubleClick={
              editable
                ? () => {
                    setDraft(task.title);
                    setEditing(true);
                  }
                : undefined
            }
            className={cn(
              "block break-words leading-snug",
              task.done && "text-muted-foreground line-through opacity-60",
            )}
            style={canFold && !textExpanded ? { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", whiteSpace: "pre-wrap" } : { whiteSpace: "pre-wrap" }}
          >
            {task.title}
          </span>
          {canFold && <button type="button" aria-label={textExpanded ? copy.collapseTask : copy.expandTask} aria-expanded={textExpanded}
            onClick={() => setTextExpanded(value => !value)}
            className="inline-flex min-h-6 items-center gap-0.5 rounded px-1 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand">
            <ChevronDown className={cn("size-3", textExpanded && "rotate-180")}/>{textExpanded ? copy.collapseTask : copy.expandTask}
          </button>}
          {/* 时间与关联只占一行，超出就截断 —— 纸片窄，信息必须让位给标题 */}
          {(task.start || task.link) && (
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
              {task.start && (
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/80">
                  {task.start}
                  {task.end ? `–${task.end}` : ""}
                </span>
              )}
              {task.link && <TaskLinkStatic link={task.link} />}
            </span>
          )}
        </div>
      )}
      <button type="button" aria-label={`${copy.details}: ${task.title}`} aria-expanded={detailsOpen} aria-controls={detailsId}
        className="paper-task-disclosure min-h-6 min-w-6" onClick={() => { const next = !detailsOpen; setDetailsOpen(next); detailsChanged.current?.(next); }}>
        {!!task.attachments?.length && <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums"><Paperclip className="size-3"/>{task.attachments.length}</span>}
        <ChevronDown className={cn("size-3.5 transition-transform", detailsOpen && "rotate-180")}/>
      </button>
      {reorder && <button type="button" draggable aria-label={`${copy.drag}: ${task.title}`} title={copy.drag}
        onDragStart={reorder.onStart} onDragEnd={reorder.onEnd}
        className="grid size-6 shrink-0 cursor-grab place-items-center rounded text-muted-foreground hover:bg-muted active:cursor-grabbing"><GripVertical className="size-3.5"/></button>}
      {detailsOpen && editable && (
        <div className="flex shrink-0 items-center gap-0.5">
          <IconBtn label={editing ? copy.save : copy.edit} onClick={() => {
            if (editing) commit();
            else { setDraft(task.title); setEditing(true); }
          }}><RiEditLine size={13} /></IconBtn>
          {onAddChild && <IconBtn label={copy.addChild} onClick={() => setAdding(!adding)}><RiAddLine size={14} /></IconBtn>}
          {reorder?.onMoveUp && <IconBtn label={copy.moveUp} onClick={reorder.onMoveUp}><ArrowUp size={13}/></IconBtn>}
          {reorder?.onMoveDown && <IconBtn label={copy.moveDown} onClick={reorder.onMoveDown}><ArrowDown size={13}/></IconBtn>}
          {onDelete && <IconBtn label={copy.remove} danger onClick={onDelete}><Trash2 size={13}/></IconBtn>}
        </div>
      )}
      {detailsOpen && <div id={detailsId} className="paper-task-details" role="region" aria-label={`${copy.details}: ${task.title}`}>
        {editable && <PlanBinding date={date} task={task} />}
        <div className="paper-task-time"><span>{copy.link}</span>
          <TaskLinkPicker link={task.link} onChange={link => usePlans.getState().updateTask(date, task.id, { link })}/>
        </div>
        <div className="paper-task-time"><span>{copy.time}</span>
          {onTimeChange && <TimeRangePicker start={task.start} end={task.end} onChange={onTimeChange} className="min-w-0 text-[11px]"/>}
        </div>
        {task.note && <p className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{task.note}</p>}
        <TaskAttachments date={date} task={task} inline/>
      </div>}
      {detailsOpen && adding && onAddChild && (
        <div className="mt-1 flex w-full items-center gap-1 pl-5">
          <input autoFocus className="daily-paper-input" value={childTitle} placeholder={copy.addChild}
            aria-label={copy.addChild}
            onChange={(event) => setChildTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); addChild(); }
              if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w")) { event.preventDefault(); event.stopPropagation(); setAdding(false); setChildTitle(""); }
            }} />
          <IconBtn label={copy.save} onClick={addChild}><RiCheckLine size={14} /></IconBtn>
          <IconBtn label={copy.cancel} onClick={() => setAdding(false)}><RiCloseLine size={14} /></IconBtn>
        </div>
      )}
    </div>
  );
}

/** 纸片标题栏上的小图标按钮 */
export function IconBtn({
  label,
  onClick,
  onPointerDown,
  children,
  danger,
  pressed,
  disabled,
}: {
  label: string;
  onClick: () => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  children: React.ReactNode;
  danger?: boolean;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onPointerDown={onPointerDown}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-35 disabled:pointer-events-none",
        pressed && "text-brand",
        danger
          ? "hover:bg-[var(--close-hover-bg)] hover:text-[var(--close-hover-fg)]"
          : "hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
