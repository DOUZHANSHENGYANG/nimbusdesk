import { useEffect, useId, useRef, useState } from "react";
import { RiCheckLine, RiAddLine, RiEditLine, RiCloseLine } from "@remixicon/react";
import { statusOf, type PlanTask } from "@/features/plans/types";
import { TaskLinkStatic } from "@/features/plans/views/task-link";
import { cn } from "@/lib/utils";
import { ChevronDown, Paperclip } from "lucide-react";
import { TimeRangePicker } from "./time-range";
import { TaskAttachments } from "@/features/plans/attachments";
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
      style={{ paddingLeft: 6 + depth * 13 }}
      className={cn(
        "daily-paper-row group flex min-h-7 flex-wrap items-start gap-x-1.5 rounded-md py-1 pr-1.5 transition-colors",
        status === "doing" && "bg-brand/5 ring-1 ring-inset ring-brand/20",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-label={task.title}
        className="mt-0.5 grid size-4 shrink-0 place-items-center"
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
            if (e.key === "Enter" && !e.nativeEvent.isComposing) commit();
            if (e.key === "Escape") {
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
          >
            {task.title}
          </span>
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
        className="paper-task-disclosure" onClick={() => { const next = !detailsOpen; setDetailsOpen(next); detailsChanged.current?.(next); }}>
        {!!task.attachments?.length && <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums"><Paperclip className="size-3"/>{task.attachments.length}</span>}
        <ChevronDown className={cn("size-3.5 transition-transform", detailsOpen && "rotate-180")}/>
      </button>
      {detailsOpen && editable && (
        <div className="flex shrink-0 items-center gap-0.5">
          <IconBtn label={editing ? copy.save : copy.edit} onClick={() => {
            if (editing) commit();
            else { setDraft(task.title); setEditing(true); }
          }}><RiEditLine size={13} /></IconBtn>
          {onAddChild && <IconBtn label={copy.addChild} onClick={() => setAdding(!adding)}><RiAddLine size={14} /></IconBtn>}
        </div>
      )}
      {detailsOpen && <div id={detailsId} className="paper-task-details" role="region" aria-label={`${copy.details}: ${task.title}`}>
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
              if (event.key === "Enter" && !event.nativeEvent.isComposing) addChild();
              if (event.key === "Escape") setAdding(false);
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
}: {
  label: string;
  onClick: () => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  children: React.ReactNode;
  danger?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={onPointerDown}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        "grid size-5 place-items-center rounded text-muted-foreground transition-colors",
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
