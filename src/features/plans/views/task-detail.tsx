import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useModal } from "@/components/shell/modal-host";
import { usePlans } from "@/features/plans/store";
import { TaskAttachments } from "@/features/plans/attachments";
import { PlanBinding } from "@/features/projects/plan-binding";
import {
  addDays,
  monthGrid,
  parseDate,
  shouldSplitPaste,
  splitPastedLines,
  todayStr,
  type PlanTask,
  type PlanTaskPatch,
} from "@/features/plans/types";
import { cn } from "@/lib/utils";
import { TimeRangePicker } from "./time-range";
import { TaskLinkBadge, TaskLinkPicker } from "./task-link";

/**
 * 任务详情面板：行的编辑器改成锚在行上的浮层。
 *
 * 为什么不再就地展开：编辑态比收起态高，保存一关就重排，
 * 下方所有行整体上移 —— 此时 pointerup 命中的已经是另一行的控件
 * （曾经真的点错过删除按钮）。浮层由 Radix 定位到上层，行高恒定，
 * 连那次「吞掉点击」的补丁也可以一并删掉。
 *
 * 为什么标题/备注走草稿而其余字段直写：逐字符 updateTask 会往撤销栈里
 * 塞一屏「修改任务」，撤销就变成逐字回退。勾选、时间、关联一次就是一个动作，
 * 直写既简单又符合「改完就生效」的预期。
 */

/** 属性行：左标签右控件，与设置页同一套信息层级 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-10 shrink-0 text-[11px] font-medium text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

/**
 * 改期：把任务（连同子树）移到另一天。
 *
 * 任务始终属于某一天（日期就是存储位置），所以没有「清除日期」——
 * 想让它换天就点另一个日子，想撤就撤销。
 */
function DateField({ date, onPick }: { date: string; onPick: (next: string) => void }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(() => {
    const d = parseDate(date);
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const locale = i18n.language === "en" ? "en-US" : "zh-CN";
  const grid = useMemo(() => monthGrid(anchor.y, anchor.m), [anchor]);
  const today = todayStr();
  const label = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", weekday: "short" }).format(parseDate(date));
  const monthLabel = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(new Date(anchor.y, anchor.m, 1));
  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
  }, [locale]);

  const pick = (day: string) => {
    setOpen(false);
    if (day !== date) onPick(day);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${t("plans.dateLabel")}: ${label}`}
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-[12px] transition-colors hover:border-brand/50"
        >
          <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" />
          {label}
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-auto p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setAnchor(shiftMonth(anchor, -1))}
            className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <span className="text-[12px] font-semibold">{monthLabel}</span>
          <button
            type="button"
            onClick={() => setAnchor(shiftMonth(anchor, 1))}
            className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>

        <div className="mb-0.5 grid grid-cols-7 gap-0.5">
          {weekdayLabels.map((w, i) => (
            <div key={i} className="py-0.5 text-center text-[10px] font-medium text-muted-foreground">
              {w}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-0.5">
          {grid.map(({ date: day, inMonth }) => (
            <button
              key={day}
              type="button"
              onClick={() => pick(day)}
              className={cn(
                "grid size-7 place-items-center rounded-md text-[11px] tabular-nums transition-colors",
                !inMonth && "opacity-35",
                day === date
                  ? "bg-brand font-semibold text-white"
                  : "hover:bg-muted hover:text-foreground",
                day === today && day !== date && "ring-1 ring-inset ring-brand/50",
              )}
            >
              {parseDate(day).getDate()}
            </button>
          ))}
        </div>

        <div className="mt-2.5 flex items-center gap-1.5 border-t border-border/60 pt-2">
          <button
            type="button"
            onClick={() => pick(today)}
            className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-brand/40 hover:text-brand"
          >
            {t("plans.today")}
          </button>
          <button
            type="button"
            onClick={() => pick(addDays(today, 1))}
            className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-brand/40 hover:text-brand"
          >
            {t("plans.tomorrow")}
          </button>
          <span className="ml-auto text-[11px] text-muted-foreground/70">{t("plans.moveHint")}</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** 月翻页：只关心年月，日期交给网格自己算 */
function shiftMonth(anchor: { y: number; m: number }, delta: number) {
  const d = new Date(anchor.y, anchor.m + delta, 1);
  return { y: d.getFullYear(), m: d.getMonth() };
}

export function TaskDetail({
  date,
  task,
  focus,
  onClose,
}: {
  date: string;
  task: PlanTask;
  /** 进来先看哪儿：点标题进来放标题，点标题下那行备注进来放备注 */
  focus: "title" | "note";
  /** 详情是列表右边的一栏，不是一个浮层 —— 关掉它就是把这一栏收起来 */
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useModal();
  const updateTask = usePlans((s) => s.updateTask);
  const addTask = usePlans((s) => s.addTask);
  const addTasks = usePlans((s) => s.addTasks);
  const removeTask = usePlans((s) => s.removeTask);
  const moveTaskToDate = usePlans((s) => s.moveTaskToDate);

  const [title, setTitle] = useState(task.title);
  const [note, setNote] = useState(task.note ?? "");
  const [child, setChild] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  /** commit 要在关闭回调里读最新草稿；回调本身得稳定，所以草稿走 ref */
  const draft = useRef({ title, note });
  draft.current = { title, note };
  /** 删除之后不该再回写草稿：那时行已经没了，写进去只会多一条撤销记录 */
  const gone = useRef(false);
  /** 换一条任务、或换落点（标题 ↔ 备注）时把光标放过去；光标停在末尾，点开就是为了接着写 */
  useEffect(() => {
    const target = focus === "note" ? noteRef.current : inputRef.current;
    if (!target) return;
    target.focus({ preventScroll: true });
    target.setSelectionRange(target.value.length, target.value.length);
  }, [task.id, focus]);

  const commit = () => {
    if (gone.current) return;
    const patch: PlanTaskPatch = {};
    const nextTitle = draft.current.title.trim();
    // 标题空着就保持原值：整包丢弃会让已改好的备注凭空消失
    if (nextTitle && nextTitle !== task.title) patch.title = nextTitle;
    const nextNote = draft.current.note.trim();
    if (nextNote !== (task.note ?? "")) patch.note = nextNote || undefined;
    if (Object.keys(patch).length) updateTask(date, task.id, patch);
  };

  /** 关这一栏统一走这里：先落地再收，别让已经改好的字卡在草稿里 */
  const close = () => {
    commit();
    onClose();
  };

  const addChild = () => {
    const v = child.trim();
    if (!v) return;
    if (shouldSplitPaste(v)) {
      const lines = splitPastedLines(v);
      if (lines.length > 1) {
        addTasks(date, task.id, lines);
        toast.success(t("plans.pasteSplit", { count: lines.length }));
        setChild("");
        return;
      }
    }
    addTask(date, task.id, v);
    setChild("");
  };

  const move = (next: string) => {
    if (!moveTaskToDate(date, task.id, next)) toast.error(t("plans.moveFailed"));
  };

  const onDelete = async () => {
    const ok = await confirm({ title: t("plans.deleteConfirm"), description: task.title, danger: true });
    if (!ok) return;
    gone.current = true;
    removeTask(date, task.id);
  };

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">{t("plans.detail")}</span>
        <button
          type="button"
          onClick={close}
          title={t("plans.closeDetail")}
          aria-label={t("plans.closeDetail")}
          className="ml-auto grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          // 回车只落地、不关这一栏：详情栏是常驻的，关它是另一个动作
          if (e.key === "Enter") commit();
          if (e.key === "Escape") close();
        }}
        aria-label={t("plans.titleLabel")}
        placeholder={t("plans.titleLabel")}
        className="w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-[13px] font-medium outline-none placeholder:text-muted-foreground/60 focus:border-brand/60"
      />

          <Field label={t("plans.dateLabel")}>
            <DateField date={date} onPick={move} />
          </Field>

          <Field label={t("plans.timeLabel")}>
            <TimeRangePicker
              start={task.start}
              end={task.end}
              onChange={({ start, end }) => updateTask(date, task.id, { start, end })}
            />
          </Field>

          <Field label={t("plans.linkLabel")}>
            {task.link && <TaskLinkBadge link={task.link} onRemove={() => updateTask(date, task.id, { link: undefined })} />}
            <TaskLinkPicker
              link={task.link}
              onChange={(link) => updateTask(date, task.id, { link })}
              className="size-7 rounded-md border border-border bg-card hover:border-brand/50"
            />
          </Field>

          <Field label={t("plans.projectLabel")}>
            <PlanBinding date={date} task={task} />
          </Field>

          <Field label={t("plans.noteLabel")}>
            {/* 文本域而不是单行输入：备注天然会写成几行，默认一行、往下自己拉 */}
            <textarea
              ref={noteRef}
              rows={1}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Escape") setNote(task.note ?? "");
              }}
              placeholder={t("plans.noteLabel")}
              aria-label={t("plans.noteLabel")}
              className="w-full min-w-0 resize-y rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12px] leading-5 outline-none placeholder:text-muted-foreground/50 focus:border-brand/60"
            />
          </Field>

          <TaskAttachments date={date} task={task} inline />

          <div className="flex items-center gap-1.5 border-t border-border/60 pt-2.5">
            <Plus className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={child}
              onChange={(e) => setChild(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addChild();
                if (e.key === "Escape") setChild("");
              }}
              placeholder={t("plans.addChild")}
              aria-label={t("plans.addChild")}
              className="w-full min-w-0 rounded-md bg-transparent px-2 py-1 text-[12px] outline-none placeholder:text-muted-foreground/60"
            />
            <button
              type="button"
              onClick={() => void onDelete()}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
              {t("plans.delete")}
            </button>
          </div>
    </div>
  );
}
