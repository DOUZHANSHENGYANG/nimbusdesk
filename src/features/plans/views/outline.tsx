import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, GripVertical, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  childrenOf,
  rangeLabel,
  shouldSplitPaste,
  splitPastedLines,
  statusOf,
  subtreeProgress,
  type PlanTask,
} from "@/features/plans/types";
import { doneTitleStyle } from "@/features/plans/views/shared";

/** 兄弟排序：未完成在前、已完成沉底（display 层，不动存储顺序 → 取消勾选自动恢复原位） */
function sortDoneLast(tasks: PlanTask[]): PlanTask[] {
  const active = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  return [...active, ...done];
}
import { useDayTasks, useNow, usePlans } from "@/features/plans/store";
import { StatusButton } from "@/features/plans/views/shared";
import { gsap, useGSAP } from "@/lib/gsap";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { TaskAttachments } from "@/features/plans/attachments";
import { TaskDetail } from "@/features/plans/views/task-detail";

/** 每层缩进（树形引导线间距） */
const INDENT = 20;

/**
 * 选中的是哪一条、进来先看哪儿。
 *
 * 点标题和点标题下那行备注都开右栏，但落点不同：点备注就是为了看/续写备注，
 * 光标还塞回标题里就白点了。
 */
type Selection = { id: string; focus: "title" | "note" };

/**
 * 拖动排序的状态与回调，由 OutlineView 持有、逐层传给任务行。
 *
 * 为什么状态放在树的根：一次拖动要同时改两行（拖起来的那行变淡、指针下那行露出落点线），
 * 每行各存一份必然对不上。形状沿用纸片那套（before/after + 源/目标 id）。
 */
type DragState = { sourceId: string; targetId?: string; position?: "before" | "after" };
type RowDrag = {
  state: DragState | null;
  onStart: (event: React.DragEvent, id: string) => void;
  onOver: (event: React.DragEvent, id: string) => void;
  onDrop: (event: React.DragEvent) => void;
  onEnd: () => void;
  /** 键盘路径：把手聚焦后 ↑↓ 换位（纯拖动等于把换位关在鼠标里） */
  reorder: (id: string, targetId: string, position: "before" | "after") => void;
};

/** 大纲视图：Todoist 式多级任务树 —— 顶部快速添加 + 引导线 + 父任务进度 + 完成沉底 */
export function OutlineView({ date, searchTaskId, searchToken }: { date: string; searchTaskId?: string; searchToken?: string }) {
  const { t } = useTranslation();
  const tasks = useDayTasks(date);
  const addTask = usePlans((s) => s.addTask);
  const addTasks = usePlans((s) => s.addTasks);
  const roots = sortDoneLast(childrenOf(tasks, null));
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState("");
  const reorderTask = usePlans((s) => s.reorderTask);
  const [selected, setSelected] = useState<Selection | null>(null);
  /** 完整详情卡片收进浮层：右栏只放备注，详情由行上的 ⋯ 打开 */
  const [detailOpen, setDetailOpen] = useState(false);
  /** 选中项要跟当天任务对得上：被删掉、被挪到别的日子之后，这一栏自己收起来 */
  const selectedTask = selected ? tasks.find((task) => task.id === selected.id) : undefined;
  useEffect(() => {
    if (selected && !selectedTask) setSelected(null);
  }, [selected, selectedTask]);

  /* ── 选中：点标题或标题下那行备注 ── */

  /** 点同一条的同一处 = 收起；点它的备注行 = 换落点但不收起 */
  const select = (id: string, focus: Selection["focus"]) =>
    setSelected((prev) => (prev?.id === id && prev.focus === focus ? null : { id, focus }));

  /* ── 拖动排序 ── */

  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const applyDrag = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const onDragStart = (event: React.DragEvent, id: string) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    // 有些浏览器不给 dragover 发自定义 MIME，带一份 text/plain 更稳
    event.dataTransfer.setData("text/plain", id);
    applyDrag({ sourceId: id });
  };

  /**
   * 指针掠过某一行：算落点。
   *
   * 只认同一个父级 —— 换层会改变「它是谁的子任务」，那是另一件事（reorderTask 也会拒）。
   * 不合法时不 preventDefault，光标自己会告诉用户「这儿放不下」。
   */
  const onDragOver = (event: React.DragEvent, id: string) => {
    const session = dragRef.current;
    if (!session || session.sourceId === id) return;
    const day = usePlans.getState().days[date] ?? [];
    const source = day.find((task) => task.id === session.sourceId);
    const target = day.find((task) => task.id === id);
    if (!source || !target || source.parentId !== target.parentId) {
      if (session.targetId) applyDrag({ sourceId: session.sourceId });
      return;
    }
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    if (session.targetId !== id || session.position !== position) {
      applyDrag({ sourceId: session.sourceId, targetId: id, position });
    }
  };

  const onDrop = (event: React.DragEvent) => {
    const session = dragRef.current;
    applyDrag(null);
    if (!session?.targetId || !session.position) return;
    event.preventDefault();
    reorderTask(date, session.sourceId, session.targetId, session.position);
  };

  const rowDrag: RowDrag = {
    state: drag,
    onStart: onDragStart,
    onOver: onDragOver,
    onDrop,
    onEnd: () => applyDrag(null),
    reorder: (id, targetId, position) => reorderTask(date, id, targetId, position),
  };
  const revealIds = useMemo(() => {
    const result = new Set<string>();
    let task = tasks.find(item => item.id === searchTaskId);
    while (task && !result.has(task.id)) {
      result.add(task.id);
      const parentId = task.parentId;
      task = parentId ? tasks.find(item => item.id === parentId) : undefined;
    }
    return result;
  }, [tasks, searchTaskId]);
  useEffect(() => {
    if (!searchTaskId) return;
    let inner = 0;
    const frame = requestAnimationFrame(() => { inner = requestAnimationFrame(() => {
      Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-search-task-id]") ?? []).find(row => row.dataset.searchTaskId === searchTaskId)?.scrollIntoView({ block: "center", behavior: "instant" });
    }); });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(inner); };
  }, [searchTaskId, searchToken, tasks]);

  useGSAP(
    () => {
      const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-row]");
      if (rows && rows.length) {
        gsap.from(rows, { autoAlpha: 0, y: 6, duration: 0.26, stagger: 0.02, ease: "power2.out", clearProps: "all" });
      }
    },
    { dependencies: [date, tasks.length], scope: listRef },
  );

  /*
   * 提交：含换行时走批量拆分。
   * 单行输入（绝大多数情况）仍走 addTask —— 两条路径各自保持简单，
   * 不为了「统一」把常见情况也塞进批量逻辑（那会多一次数组分配）。
   */
  const submit = () => {
    const v = input.trim();
    if (!v) return;
    if (shouldSplitPaste(v)) {
      const lines = splitPastedLines(v);
      if (lines.length > 1) {
        addTasks(date, null, lines);
        toast.success(t("plans.pasteSplit", { count: lines.length }));
        setInput("");
        return;
      }
    }
    addTask(date, null, v);
    setInput("");
  };

  return (
    /* 列表 + 详情两栏：详情是这一页的第三栏，不盖住任何一行（浮层会压住下面几行） */
    <div className="flex min-w-0 items-start gap-4">
      <div className="flex min-w-0 flex-1 flex-col" ref={listRef}>
        {/* 顶部快速添加：不加框，跟任务行同一套形状（它本来就是「第一行任务」） */}
        <div className="mb-1 flex items-center gap-2.5 rounded-lg px-1.5 py-2.5 transition-colors hover:bg-surface-hover focus-within:bg-surface-hover">
          <Plus className="size-4 shrink-0 text-brand" strokeWidth={2.4} />
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder={t("plans.addPlaceholder")}
            className="w-full rounded-md bg-transparent px-2 py-1 text-[13px] outline-none placeholder:text-muted-foreground/60"
          />
        </div>

        {roots.length === 0 ? (
          /* 空状态本身就是入口：点一下光标就落到上面那个输入框，不用先找它在哪 */
          <button
            type="button"
            onClick={() => inputRef.current?.focus()}
            className="py-8 text-center text-[13px] text-muted-foreground transition-colors hover:text-brand"
          >
            {t("plans.emptyDay")}
          </button>
        ) : (
          <RowsWithDoneDivider
            list={roots}
            dividerIndent={4}
            label={t("plans.doneGroup")}
            render={(task) => <TaskRow date={date} task={task} depth={0} drag={rowDrag} selectedId={selected?.id ?? null} onSelect={select} onDetail={(id) => { setSelected({ id, focus: "title" }); setDetailOpen(true); }} searchTaskId={searchTaskId} revealIds={revealIds} searchToken={searchToken} />}
          />
        )}
      </div>

      {selectedTask && (
        <aside
          aria-label={t("plans.detail")}
          className="w-80 shrink-0 rounded-xl border border-border bg-card/40"
        >
          {detailOpen ? (
            <>
              {/* 详情浮层：背板只挡鼠标，× / Esc 关闭；右栏本身只放备注，所以这里是唯一入口 */}
              <button
                type="button"
                aria-label={t("plans.closeDetail")}
                onClick={() => setDetailOpen(false)}
                className="fixed inset-0 z-30 cursor-default"
              />
              <div className="fixed right-6 top-16 z-40 max-h-[70vh] w-[min(380px,90vw)] overflow-auto rounded-2xl border border-border bg-card shadow-[var(--pr-shadow-3)]">
                <TaskDetail
                  date={date}
                  task={selectedTask}
                  focus="title"
                  onClose={() => setDetailOpen(false)}
                />
              </div>
            </>
          ) : (
            <NoteColumn date={date} task={selectedTask} focus={selected!.focus} onClose={() => setSelected(null)} />
          )}
        </aside>
      )}
    </div>
  );
}

/**
 * 渲染一行列表（根级或子级），完成项前插一个分组头。
 *
 * 头是可折叠的：一整组完成项是「回头看一眼」用的，平时该让位给还没做的；
 * 计数跟头在一起，收起后也知道自己完成了几条。
 */
function RowsWithDoneDivider({
  list,
  render,
  dividerIndent,
  label,
}: {
  list: PlanTask[];
  render: (task: PlanTask) => React.ReactNode;
  dividerIndent: number;
  label: string;
}) {
  const [doneOpen, setDoneOpen] = useState(true);
  const activeCount = list.filter((t) => !t.done).length;
  const doneCount = list.length - activeCount;
  return (
    <>
      {list.map((task, idx) => (
        <Fragment key={task.id}>
          {doneCount > 0 && idx === activeCount && (
            <button
              type="button"
              onClick={() => setDoneOpen(!doneOpen)}
              aria-expanded={doneOpen}
              className="flex w-fit items-center gap-1 rounded-lg py-1.5 pr-2 text-[11px] font-semibold text-muted-foreground/80 transition-colors hover:bg-surface-hover hover:text-foreground"
              style={{ paddingLeft: dividerIndent + 4 }}
            >
              <ChevronRight
                className={cn("size-3.5 transition-transform duration-200", doneOpen && "rotate-90")}
              />
              {label}
              <span className="font-medium tabular-nums text-muted-foreground/60">{doneCount}</span>
            </button>
          )}
          {(idx < activeCount || doneOpen) && render(task)}
        </Fragment>
      ))}
    </>
  );
}

/** 显形的条件：悬停、键盘聚焦，以及「没有悬停这回事」的设备（触屏一律常显） */
const REVEAL = "opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100";

/**
 * 行内小图标按钮：占位常驻、只在悬停时显形。
 *
 * 占位常驻是关键 —— 悬停才「挤出来」会让整行文字横向跳动，
 * 就地编辑踩过这个坑（那次是纵向的），别再来一次。
 */
function RowIcon({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
        REVEAL,
      )}
    >
      {children}
    </button>
  );
}

/**
 * 一行任务。
 *
 * 行上只留「这一条是什么」：状态、标题、进度、备注、时间、关联、附件、项目。
 * 一切「改这一条」的动作都收进右边那一栏 —— 行不再变高变矮，
 * 也不再需要在行里判断「点到行外算不算保存」。拖动把手、加子任务、更多
 * 挤在标题后面显形：动作都在一块，不用去行两端各找一遍。
 */
/**
 * 右栏 = 只有备注。
 *
 * 之前这一栏是完整详情卡片：想写句备注要在一堆字段里找，改个日期又得滚过去。现在它就一件事 ——
 * 写备注。进来即聚焦，离开焦点即存，没有保存按钮（和标题同一套写法：一次编辑一次提交，
 * 不是每敲一个字都进撤销栈）。完整卡片收在行上的 ⋯ 里。
 */
function NoteColumn({ date, task, focus, onClose }: { date: string; task: PlanTask; focus: Selection["focus"]; onClose: () => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(task.note ?? "");
  const commit = () => {
    const next = draft.trim();
    if (next !== (task.note ?? "")) usePlans.getState().updateTask(date, task.id, { note: next || undefined });
  };
  return (
    <aside aria-label="任务详情" data-note-title={task.title} className="flex h-full min-h-0 w-72 shrink-0 flex-col">
      <div className="flex items-center gap-2 px-3 pb-1 pt-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-muted-foreground">{task.title}</span>
        <button
          type="button"
          aria-label={t("plans.closeDetail")}
          onClick={() => { commit(); onClose(); }}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          ×
        </button>
      </div>
      <textarea
        key={`${task.id}:${focus}`}
        autoFocus
        aria-label={t("plans.noteLabel")}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        className="min-h-0 w-full flex-1 resize-none border-0 bg-transparent px-3 pb-2 text-[12px] leading-5 outline-none"
      />
    </aside>
  );
}

function TaskRow({ date, task, depth, drag, selectedId, onSelect, onDetail, searchTaskId, revealIds, searchToken }: { date: string; task: PlanTask; depth: number; drag: RowDrag; selectedId: string | null; onSelect: (id: string, focus: Selection["focus"]) => void; onDetail: (id: string) => void; searchTaskId?: string; revealIds: Set<string>; searchToken?: string }) {
  const { t } = useTranslation();
  const tasks = useDayTasks(date);
  const now = useNow();
  const toggleDone = usePlans((s) => s.toggleDone);
  const addTask = usePlans((s) => s.addTask);
  const addTasks = usePlans((s) => s.addTasks);

  const children = sortDoneLast(childrenOf(tasks, task.id));
  const sub = subtreeProgress(tasks, task.id);
  const status = statusOf(task, date, now);
  const range = rangeLabel(task);
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [childInput, setChildInput] = useState("");
  useEffect(() => { if (revealIds.has(task.id)) setOpen(true); }, [revealIds, task.id, searchToken]);

  /** 再点一次就收起详情栏：选中是一个开关，不用专门去找关闭按钮 */
  const selectTitle = () => onSelect(task.id, "title");

  const addChild = () => {
    const v = childInput.trim();
    if (!v) return;
    if (shouldSplitPaste(v)) {
      const lines = splitPastedLines(v);
      if (lines.length > 1) {
        addTasks(date, task.id, lines);
        toast.success(t("plans.pasteSplit", { count: lines.length }));
        setChildInput("");
        return;
      }
    }
    addTask(date, task.id, v);
    setChildInput("");
  };

  const hasKids = children.length > 0;
  const dragging = drag.state?.sourceId === task.id;
  const dropPosition = drag.state?.targetId === task.id ? drag.state.position : undefined;

  /** ↑↓ 按**存储顺序**的邻居换位（显示顺序会把已完成沉底，两者可能不同） */
  const moveBy = (delta: number) => {
    const list = childrenOf(tasks, task.parentId);
    const target = list[list.findIndex((item) => item.id === task.id) + delta];
    if (target) drag.reorder(task.id, target.id, delta < 0 ? "before" : "after");
  };

  return (
    <div data-row>
      <div
        data-search-task-id={task.id}
        onDragOver={(e) => drag.onOver(e, task.id)}
        onDrop={drag.onDrop}
        className={cn(
          "group flex min-h-10 items-center gap-2 rounded-lg py-1 pr-1 transition-colors hover:bg-surface-hover",
          // 进行中：左侧一条品牌色标记，扫一眼就能看到当前该做什么
          status === "doing" && "bg-brand/5 ring-1 ring-inset ring-brand/20",
          task.id === searchTaskId && "bg-brand/10 ring-1 ring-inset ring-brand/50",
          selectedId === task.id && "bg-surface-hover ring-1 ring-inset ring-brand/40",
          dragging && "opacity-50",
          // 落点：贴着目标行的上/下边画一条线，比整行描边更能看出「插到哪里」
          dropPosition === "before" && "shadow-[inset_0_2px_0_var(--brand)]",
          dropPosition === "after" && "shadow-[inset_0_-2px_0_var(--brand)]",
        )}
        style={{ paddingLeft: 4 }}
      >
        {/* 拖动把手：占位常驻、只在悬停时显形 —— 出现和消失都不挪动任何像素 */}
        <button
          type="button"
          draggable
          onClick={(e) => e.preventDefault()}
          onDragStart={(e) => drag.onStart(e, task.id)}
          onDragEnd={drag.onEnd}
          onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            moveBy(e.key === "ArrowUp" ? -1 : 1);
          }}
          title={t("plans.dragTask")}
          aria-label={`${t("plans.dragTask")}: ${task.title}`}
          className={cn(
            "grid size-5 shrink-0 cursor-grab place-items-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground active:cursor-grabbing",
            REVEAL,
          )}
        >
          <GripVertical className="size-3.5" />
        </button>

        {/* 展开/占位 */}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={cn(
            "grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-transform duration-200",
            hasKids ? "hover:bg-muted hover:text-foreground" : "invisible",
            open && hasKids && "rotate-90",
          )}
        >
          <ChevronRight className="size-4" />
        </button>

        <StatusButton status={status} onToggle={() => toggleDone(date, task.id)} />

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* 第一行：标题 + 紧随其后的动作块（悬停才显形），时间靠右 */}
          <div className="flex min-w-0 items-start gap-1.5">
            <button
              type="button"
              onClick={selectTitle}
              title={t("plans.openDetail")}
              className="min-w-0 text-left text-[13px] leading-5"
            >
              <span style={doneTitleStyle(task.done)}>
                {task.title}
              </span>
              {/* 父任务进度徽章 */}
              {sub.total > 0 && (
                <span
                  className={cn(
                    "ml-2 inline-block rounded-full px-1.5 py-px align-middle text-[10px] font-semibold",
                    sub.done === sub.total
                      ? "bg-success/15 text-success"
                      : "bg-brand/10 text-brand",
                  )}
                >
                  {sub.done}/{sub.total}
                </span>
              )}
              {status === "doing" && (
                <span className="ml-2 inline-block rounded-full bg-brand px-1.5 py-px align-middle text-[10px] font-semibold text-white">
                  {t("plans.status.doing")}
                </span>
              )}
            </button>

            {/* 动作块：加子任务 + 详情（⋯）。详情卡片是完整形态，行上只留这一个入口 */}
            <RowIcon title={t("plans.detail")} onClick={() => onDetail(task.id)}>
              <span className="text-[13px] leading-none tracking-tight">⋯</span>
            </RowIcon>
            <RowIcon title={t("plans.addChild")} onClick={() => setAdding(!adding)}>
              <Plus className="size-4" />
            </RowIcon>

            {range && (
              <span className="ml-auto shrink-0 font-mono text-[11px] leading-5 text-muted-foreground/80">
                {range}
              </span>
            )}
          </div>

          {/* 备注：独占一行，点它直接进右栏的备注 —— 这一行本来就是「看备注」的入口 */}
          {task.note && (
            <button
              type="button"
              onClick={() => onSelect(task.id, "note")}
              className="min-w-0 truncate text-left text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground"
            >
              {task.note}
            </button>
          )}
        </div>

        {/* 附件留在行上：它描述「这一条是什么」，不是动作。项目关联与链接已经只在详情卡片里
            出现，行上再摆一份就是重复（原来那块「未关联任务 ⌄ + 🔗」） */}
        <div className="flex shrink-0 items-center gap-0.5">
          <TaskAttachments date={date} task={task} />
        </div>
      </div>

      {/* 添加子任务输入（行上的 + 打开；面板里也有同一个入口） */}
      {adding && (
        <div className="flex items-center gap-2 py-1" style={{ paddingLeft: 46 + depth * INDENT }}>
          <input
            autoFocus
            value={childInput}
            onChange={(e) => setChildInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addChild();
              if (e.key === "Escape") setAdding(false);
            }}
            onBlur={addChild}
            placeholder={t("plans.addPlaceholder")}
            aria-label={t("plans.addChild")}
            className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-[12px] outline-none placeholder:text-muted-foreground/50 focus:border-brand/50"
          />
        </div>
      )}

      {/* 子树：缩进 + 竖向引导线（Workflowy 式层级视觉） */}
      {open && hasKids && (
        <div
          className="relative border-l-2 border-border/50"
          style={{ marginLeft: 14 + depth * INDENT }}
        >
          <RowsWithDoneDivider
            list={children}
            dividerIndent={4}
            label={t("plans.doneGroup")}
            render={(child) => <TaskRow date={date} task={child} depth={depth + 1} drag={drag} selectedId={selectedId} onSelect={onSelect} onDetail={onDetail} searchTaskId={searchTaskId} revealIds={revealIds} searchToken={searchToken} />}
          />
        </div>
      )}
    </div>
  );
}
