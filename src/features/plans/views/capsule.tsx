import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight, ChevronDown, ChevronUp, Maximize2, Palette, Plus, Redo2, Search, Undo2, X } from "lucide-react";
import { EdgeDockFrame, useEdgeDock } from "@/features/desktop/edge-dock";
import { flattenTree } from "@/features/plans/capsule";
import { COLLAPSED_PAPER_H } from "@/features/plans/capsule-window";
import { fmtDate, parseDate } from "@/features/plans/types";
import { useDayTasks, useNow, usePlans } from "@/features/plans/store";
import { IconBtn, PaperRow } from "@/features/plans/views/paper-row";
import { paperGeometryFor, usePapers } from "@/stores/papers";
import { findPaperTasks, paperKeyAction, pastedTaskTitles } from "@/features/plans/paper-interactions";
import { usePlanCopy } from "@/features/plans/copy";

/** One real interactive edge tab. Native placement and pointer intent belong to the shared dock. */
export function CapsuleView({ date, onExpand, onClose }: {
  date: string;
  onExpand: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const tasks = useDayTasks(date);
  const now = useNow();
  const copy = usePlanCopy();
  const history = usePlans((state) => state.history);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef("");
  const composing = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const toggleDone = usePlans((s) => s.toggleDone);
  const updateTask = usePlans((s) => s.updateTask);
  const addTask = usePlans((s) => s.addTask);
  const addTasks = usePlans((s) => s.addTasks);
  const stored = usePapers((s) => s.papers[date]);
  const normal = useCallback(() => {
    const g = paperGeometryFor(date);
    return { x: g.x, y: g.y, w: g.w, h: g.collapsed ? COLLAPSED_PAPER_H : g.h };
  }, [date]);
  const dock = useEdgeDock({
    active: true,
    edge: stored?.edge ?? "right",
    edgeY: stored?.edgeY,
    normal,
    pinned: stored?.pinned ?? false,
    appearance: stored,
    onAppearanceChange: patch => usePapers.getState().setStickyAppearance(date, patch),
    onEdgeChange: (edge) => usePapers.getState().setEdge(date, edge),
    onEdgeYChange: (y) => usePapers.getState().setEdgeY(date, y),
    onUndock: onExpand,
  });
  const rows = useMemo(() => flattenTree(tasks), [tasks]);
  const matches = useMemo(() => findPaperTasks(rows.map(row => row.task), query), [rows, query]);
  const currentMatch = matches.length ? matches[matchIndex % matches.length] : undefined;
  const navigate = (direction: number) => setMatchIndex(index => matches.length ? (index + direction + matches.length) % matches.length : 0);
  useEffect(() => {
    dock.hold("task-find", findOpen);
    if (findOpen) findRef.current?.focus();
    return () => dock.hold("task-find", false);
  }, [findOpen, dock.hold]);
  useEffect(() => { if (!dock.opened) setFindOpen(false); }, [dock.opened]);
  useEffect(() => () => dock.hold("task-focus", false), [dock.hold]);
  useEffect(() => {
    if (findOpen && currentMatch) Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-paper-task]") ?? []).find(node => node.dataset.paperTask === currentMatch)?.scrollIntoView({ block: "nearest" });
  }, [currentMatch, findOpen]);
  const doneCount = tasks.filter((task) => task.done).length;
  const label = date === fmtDate(new Date()) ? t("plans.today") : new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" }).format(parseDate(date));
  const addLabel = i18n.language.startsWith("en") ? "Add task" : "添加任务";
  const updateInput = (value: string) => { draftRef.current = value; setInput(value); };
  const submit = () => {
    if (composing.current) return;
    const title = draftRef.current.trim();
    if (!title) return;
    // Consume the draft before updating the shared store so repeated activation cannot add it twice.
    updateInput("");
    addTask(date, null, title);
    inputRef.current?.focus();
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    const action = paperKeyAction(event.nativeEvent, { editable: !!target.closest("input,textarea,select,[contenteditable=true]"), findInput: !!target.closest("[data-paper-find]"), composing: event.nativeEvent.isComposing, dragging: false, findOpen, selectedCount: 0 });
    if (!action || action === "select-all") return;
    event.preventDefault(); event.stopPropagation();
    if (action === "cancel-edit") target.blur();
    if (action === "close-find") setFindOpen(false);
    if (action === "fold") void dock.dismiss();
    if (action === "find" || action === "find-next" || action === "find-previous") { setFindOpen(true); findRef.current?.focus(); }
    if (action === "find-next") navigate(1);
    if (action === "find-previous") navigate(-1);
    if (action === "undo") usePlans.getState().undo();
    if (action === "redo") usePlans.getState().redo();
  };

  return <EdgeDockFrame dock={dock} label={label} summary={`${doneCount}/${tasks.length}`} en={i18n.language.startsWith("en")}>
    <div onKeyDown={onKey} className="flex h-full flex-col overflow-hidden text-[13px]"
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onFocusCapture={(event) => dock.hold("task-focus", event.target.matches("input,textarea,select,[contenteditable=true]"))}
      onBlurCapture={(event) => { if (!(event.relatedTarget instanceof HTMLElement) || !event.currentTarget.contains(event.relatedTarget) || !event.relatedTarget.matches("input,textarea,select,[contenteditable=true]")) dock.hold("task-focus", false); }}>
      <div onPointerDown={dock.startDrag} className="flex h-9 shrink-0 cursor-default items-center gap-1.5 border-b border-border/60 px-2.5 select-none"
        style={dock.tabTop > 0 ? { [dock.edge === "right" ? "paddingLeft" : "paddingRight"]: 24 } : undefined}>
        <span className="min-w-0 flex-1 truncate font-semibold">{label}</span>
        {tasks.length > 0 && <span className="shrink-0 rounded-full bg-brand/10 px-1.5 text-[10px] font-semibold tabular-nums text-brand">{doneCount}/{tasks.length}</span>}
        <div className="flex shrink-0 items-center gap-0.5">
          <IconBtn label={t("plans.capsuleSwitchEdge")} onClick={() => void dock.switchEdge()}><ArrowLeftRight className="size-3.5" /></IconBtn>
          <IconBtn label={t("plans.capsuleExpand")} onClick={() => void dock.undock()}><Maximize2 className="size-3.5" /></IconBtn>
          <IconBtn label={t("titlebar.close")} danger onClick={onClose}><X className="size-3.5" /></IconBtn>
        </div>
      </div>
      <div className="flex min-h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <IconBtn label={copy.find} pressed={findOpen} onClick={() => { setFindOpen(true); findRef.current?.focus(); }}><Search size={14}/></IconBtn>
        <IconBtn label={i18n.language.startsWith("en") ? "Sticky appearance and size" : "便签外观与大小"} onClick={() => void dock.openAppearance()}><Palette size={14}/></IconBtn>
        <span className="flex-1"/>
        <IconBtn label={copy.undo} disabled={!history.past.length} onClick={() => usePlans.getState().undo()}><Undo2 size={14}/></IconBtn>
        <IconBtn label={copy.redo} disabled={!history.future.length} onClick={() => usePlans.getState().redo()}><Redo2 size={14}/></IconBtn>
      </div>
      {findOpen && <div data-paper-find className="flex min-h-9 shrink-0 items-center gap-0.5 border-b border-border/60 px-2">
        <input ref={findRef} value={query} aria-label={copy.find} placeholder={copy.find} className="min-w-0 flex-1 bg-transparent text-xs outline-none"
          onChange={event => { setQuery(event.target.value); setMatchIndex(0); }}
          onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); navigate(event.shiftKey ? -1 : 1); } }}/>
        <span role="status" aria-live="polite" className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{matches.length ? `${matchIndex % matches.length + 1}/${matches.length}` : "0/0"}</span>
        <IconBtn label={copy.previousMatch} disabled={!matches.length} onClick={() => navigate(-1)}><ChevronUp size={14}/></IconBtn>
        <IconBtn label={copy.nextMatch} disabled={!matches.length} onClick={() => navigate(1)}><ChevronDown size={14}/></IconBtn>
        <IconBtn label={copy.closeFind} onClick={() => setFindOpen(false)}><X size={14}/></IconBtn>
      </div>}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {rows.length === 0 ? <p className="px-2 py-8 text-center text-[12px] text-muted-foreground/70">{t("plans.emptyDay")}</p> : rows.map(({ task, depth }) => <PaperRow
          key={task.id} date={date} task={task} now={now} depth={depth} active={dock.opened}
          searchMatch={findOpen && matches.includes(task.id) ? (currentMatch === task.id ? "current" : "match") : undefined}
          onToggle={() => toggleDone(date, task.id)}
          onEdit={(title) => updateTask(date, task.id, { title })}
          onAddChild={(title) => addTask(date, task.id, title)}
          onTimeChange={(time) => updateTask(date, task.id, time)}
          onDetailsChange={(open) => dock.hold(`task-details:${task.id}`, open)}
        />)}
      </div>
      <form className="flex min-h-10 shrink-0 items-center gap-1.5 border-t border-border/60 px-2.5 py-1.5"
        style={dock.tabTop === 0 ? { [dock.resizeFromLeft ? "paddingLeft" : "paddingRight"]: 24 } : undefined}
        onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <input ref={inputRef} value={input} aria-label={t("plans.addPlaceholder")} placeholder={t("plans.addPlaceholder")}
          onChange={(event) => updateInput(event.target.value)}
          onPaste={(event) => {
            if (composing.current) return;
            const field = event.currentTarget;
            const value = draftRef.current;
            const titles = pastedTaskTitles(event.clipboardData.getData("text/plain"), value.slice(0, field.selectionStart ?? value.length), value.slice(field.selectionEnd ?? value.length));
            if (!titles) return;
            event.preventDefault(); updateInput(""); addTasks(date, null, titles);
          }}
          onKeyDown={(event) => {
            if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
              return;
            }
            if (event.key === "Enter") { event.preventDefault(); if (!event.repeat) submit(); }
            if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w")) {
              event.preventDefault(); event.stopPropagation(); updateInput(""); event.currentTarget.blur();
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"/>
        <button type="submit" aria-label={addLabel} title={addLabel} disabled={!input.trim()}
          className="grid size-7 shrink-0 place-items-center rounded-md bg-brand/15 text-brand transition-colors hover:bg-brand/25 focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-default disabled:opacity-35">
          <Plus className="size-4"/>
        </button>
      </form>
    </div>
  </EdgeDockFrame>;
}
