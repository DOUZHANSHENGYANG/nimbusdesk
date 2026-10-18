import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Pencil, Plus, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  childrenOf,
  rangeLabel,
  shouldSplitPaste,
  splitPastedLines,
  statusOf,
  subtreeProgress,
  type PlanTask,
  type TaskLink,
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
import { TimeRangePicker } from "@/features/plans/views/time-range";
import { useModal } from "@/components/shell/modal-host";
import { gsap, useGSAP } from "@/lib/gsap";
import { cn } from "@/lib/utils";
import { useDismiss } from "@/lib/hooks/use-dismiss";
import { TaskLinkBadge, TaskLinkPicker } from "@/features/plans/views/task-link";
import { toast } from "sonner";
import { TaskAttachments } from "@/features/plans/attachments";
import { PlanBinding } from "@/features/projects/plan-binding";

/** 每层缩进（树形引导线间距） */
const INDENT = 20;

/** 大纲视图：Todoist 式多级任务树 —— 顶部快速添加 + 引导线 + 父任务进度 + 完成沉底 */
export function OutlineView({ date, searchTaskId, searchToken }: { date: string; searchTaskId?: string; searchToken?: string }) {
  const { t } = useTranslation();
  const tasks = useDayTasks(date);
  const addTask = usePlans((s) => s.addTask);
  const addTasks = usePlans((s) => s.addTasks);
  const roots = sortDoneLast(childrenOf(tasks, null));
  const listRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");
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
    <div className="flex flex-col" ref={listRef}>
      {/* 顶部快速添加（Todoist 式） */}
      <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-2.5 transition-colors focus-within:border-brand/60 focus-within:shadow-[var(--pr-shadow-glow)]">
        <Plus className="size-4 shrink-0 text-brand" strokeWidth={2.4} />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={t("plans.addPlaceholder")}
          className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
        />
      </div>

      {roots.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-muted-foreground">{t("plans.emptyDay")}</p>
      ) : (
        <RowsWithDoneDivider
          list={roots}
          dividerIndent={4}
          label={t("plans.doneGroup")}
          render={(task) => <TaskRow date={date} task={task} depth={0} searchTaskId={searchTaskId} revealIds={revealIds} searchToken={searchToken} />}
        />
      )}
    </div>
  );
}

/** 渲染一行列表（根级或子级），已完成后插入分组分隔线 */
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
  const activeCount = list.filter((t) => !t.done).length;
  return (
    <>
      {list.map((task, idx) => (
        <Fragment key={task.id}>
          {idx === activeCount && activeCount > 0 && activeCount < list.length && (
            <div
              className="flex items-center gap-2 py-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground/70"
              style={{ paddingLeft: dividerIndent }}
            >
              <span className="h-px flex-1 bg-border" />
              {label}
              <span className="h-px flex-1 bg-border" />
            </div>
          )}
          {render(task)}
        </Fragment>
      ))}
    </>
  );
}

function TaskRow({ date, task, depth, searchTaskId, revealIds, searchToken }: { date: string; task: PlanTask; depth: number; searchTaskId?: string; revealIds: Set<string>; searchToken?: string }) {
  const { t } = useTranslation();
  const { confirm } = useModal();
  const tasks = useDayTasks(date);
  const now = useNow();
  const addTask = usePlans((s) => s.addTask);
  const addTasks = usePlans((s) => s.addTasks);
  const updateTask = usePlans((s) => s.updateTask);
  const removeTask = usePlans((s) => s.removeTask);
  const toggleDone = usePlans((s) => s.toggleDone);

  const children = sortDoneLast(childrenOf(tasks, task.id));
  const sub = subtreeProgress(tasks, task.id);
  const status = statusOf(task, date, now);
  const range = rangeLabel(task);
  const [open, setOpen] = useState(true);
  useEffect(() => { if (revealIds.has(task.id)) setOpen(true); }, [revealIds, task.id, searchToken]);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{
    title: string;
    start?: string;
    end?: string;
    note: string;
    link?: TaskLink;
  }>({
    title: "",
    note: "",
  });
  const [childInput, setChildInput] = useState("");
  /**
   * 编辑态的边界：整行都算「里面」。
   *
   * 用户的心智是「点到别的任务/空白处才离开编辑」，所以点这一行的复选框、
   * 展开箭头时不该把编辑关掉 —— 边界因此是行而不是编辑框本身。
   */
  const rowRef = useRef<HTMLDivElement>(null);

  /**
   * 让 saveEdit 保持稳定引用（useDismiss 要求回调稳定，否则每次渲染都重绑监听）。
   * draft 通过 ref 读取最新值，这样回调不必依赖 draft。
   */
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const startEdit = () => {
    setDraft({
      title: task.title,
      start: task.start,
      end: task.end,
      note: task.note ?? "",
      link: task.link,
    });
    // 关掉「添加子任务」输入框：它在编辑边界（本行 div）之外，
    // 留着的话点它会先触发「保存并关闭编辑」，与用户心智不符；
    // 而且编辑态下 + 按钮本来就是隐藏的，它不该同时可见。
    setAdding(false);
    setEditing(true);
  };

  /**
   * 保存并退出。
   *
   * 标题是必填项：为空时不写标题（保持原值），但**备注与时间的改动照存** ——
   * 整包丢弃会让用户已经改好的备注凭空消失，而界面只显示标题没变，
   * 用户根本不知道自己的备注被吞了。
   */
  const saveEdit = useCallback(() => {
    const d = draftRef.current;
    const title = d.title.trim();
    updateTask(date, task.id, {
      ...(title ? { title } : {}),
      start: d.start,
      end: d.end,
      note: d.note.trim() || undefined,
      // 显式写 undefined（而不是省略）才能把关联删掉：
      // 省略这个键等于「不改」，用户点了移除却发现还在
      link: d.link,
    });
    setEditing(false);
  }, [date, task.id, updateTask]);

  const cancelEdit = useCallback(() => setEditing(false), []);

  /*
   * 点到本行之外 → 自动保存并关闭。
   *
   * escape: false —— Escape 由输入框自己处理成「取消」（不保存），
   * 若让 useDismiss 也管 Escape，两个回调会同时触发，语义互相矛盾。
   *
   * behavior: "consume" —— 必须吞掉这次 click。
   * 编辑框比收起后的行高，pointerdown 触发保存关闭后 React 立刻重渲染，
   * 下方所有行会整体上移；此时 pointerup/click 落在屏幕同一坐标，
   * 命中的已经是**另一行**的控件（复选框、甚至删除按钮）。不吞掉就会误触。
   * 代价是「点另一行的标题开始编辑它」需要点两下 —— 与主流内联编辑器一致。
   *
   * ignore 必须稳定（useDismiss 的 effect 依赖它，内联箭头函数会让监听器
   * 每次渲染都重绑）：时间选择器的弹层是 portal 到 body 的，
   * 点它选时间时在 DOM 上属于「行外」，不排除的话一选时间就把编辑关掉了。
   */
  const ignorePopover = useCallback(
    (target: Element) => Boolean(target.closest('[data-slot="popover-content"]')),
    [],
  );
  useDismiss(editing, saveEdit, rowRef, {
    escape: false,
    behavior: "consume",
    ignore: ignorePopover,
  });

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

  const onDelete = async () => {
    const ok = await confirm({
      title: t("plans.deleteConfirm"),
      description: task.title,
      danger: true,
    });
    if (ok) removeTask(date, task.id);
  };

  const hasKids = children.length > 0;

  return (
    <div data-row>
      {/* 任务行（编辑态边界：点子任务行/别处都算「外面」→ 自动保存关闭） */}
      <div
        ref={rowRef}
        data-search-task-id={task.id}
        className={cn(
          "group flex min-h-10 items-center gap-2 rounded-lg py-1 pr-1 transition-colors hover:bg-surface-hover",
          // 进行中：左侧一条品牌色标记，扫一眼就能看到当前该做什么
          status === "doing" && "bg-brand/5 ring-1 ring-inset ring-brand/20",
          task.id === searchTaskId && "bg-brand/10 ring-1 ring-inset ring-brand/50",
        )}
        style={{ paddingLeft: 4 }}
      >
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

        {/* 标题 / 编辑态 */}
        {editing ? (
          <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-lg border border-border bg-card p-2.5">
            {/* 第一行：标题（弹性）+ 时间 + 确认/取消（图标按钮，视觉重量一致） */}
            <div className="flex min-w-0 items-center gap-2">
              <input
                autoFocus
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveEdit();
                  if (e.key === "Escape") setEditing(false);
                }}
                className="min-w-0 flex-1 bg-transparent text-[13px] font-medium outline-none"
                placeholder={t("plans.titleLabel")}
              />
              <TaskLinkPicker
                link={draft.link}
                onChange={(link) => setDraft({ ...draft, link })}
              />
              <TimeRangePicker
                start={draft.start}
                end={draft.end}
                onChange={({ start, end }) => setDraft({ ...draft, start, end })}
              />
              <button
                type="button"
                onClick={saveEdit}
                title={t("common.confirm")}
                aria-label={t("common.confirm")}
                className="grid size-6 shrink-0 place-items-center rounded-md text-brand transition-colors hover:bg-brand/10"
              >
                <Check className="size-4" strokeWidth={2.6} />
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                title={t("common.cancel")}
                aria-label={t("common.cancel")}
                className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* 第二行：备注独占一行，给足横向空间 */}
            <input
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveEdit();
                if (e.key === "Escape") setEditing(false);
              }}
              placeholder={t("plans.noteLabel")}
              className="w-full bg-transparent text-[12px] text-muted-foreground outline-none placeholder:text-muted-foreground/50"
            />
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {/* 第一行：标题靠左、时间靠右（标题过长换行时时间仍停在首行） */}
            <div className="flex min-w-0 items-start gap-2">
              <button
                type="button"
                onClick={startEdit}
                title={t("plans.editTip")}
                className="min-w-0 flex-1 text-left text-[13px] leading-5"
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
                {task.link && (
                  <TaskLinkBadge
                    link={task.link}
                    onRemove={() => updateTask(date, task.id, { link: undefined })}
                  />
                )}
              </button>

              {range && (
                <span className="shrink-0 font-mono text-[11px] leading-5 text-muted-foreground/80">
                  {range}
                </span>
              )}
            </div>

            {/* 备注：独占一行 */}
            {task.note && (
              <span
                className="min-w-0 truncate text-[11px] text-muted-foreground/70"
                title={task.note}
              >
                {task.note}
              </span>
            )}
          </div>
        )}

        {/* 操作与附件保持同行，便于直接发现入口。 */}
        {!editing && (
          <div className="flex shrink-0 items-center gap-0.5">
            <PlanBinding date={date} task={task} />
            <TaskAttachments date={date} task={task} />
            <RowAction title={t("plans.editTip")} onClick={startEdit}>
              <Pencil className="size-3.5" />
            </RowAction>
            <RowAction title={t("plans.addChild")} onClick={() => setAdding(!adding)}>
              <Plus className="size-4" />
            </RowAction>
            <RowAction title={t("common.confirm")} danger onClick={() => void onDelete()}>
              <Trash2 className="size-3.5" />
            </RowAction>
          </div>
        )}
      </div>

      {/* 添加子任务输入 */}
      {adding && (
        <div
          className="flex items-center gap-2 py-1"
          style={{ paddingLeft: 26 + depth * INDENT }}
        >
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
            render={(child) => <TaskRow date={date} task={child} depth={depth + 1} searchTaskId={searchTaskId} revealIds={revealIds} searchToken={searchToken} />}
          />
        </div>
      )}
    </div>
  );
}

function RowAction({
  title,
  danger,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "grid size-6 place-items-center rounded-md text-muted-foreground transition-colors",
        danger ? "hover:bg-destructive/10 hover:text-destructive" : "hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
