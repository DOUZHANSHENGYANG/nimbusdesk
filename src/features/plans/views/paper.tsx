import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronUp, Pin, PinOff, Plus, X } from "lucide-react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  childrenOf,
  fmtDate,
  parseDate,
  shouldSplitPaste,
  splitPastedLines,
  statusOf,
  type PlanTask,
} from "@/features/plans/types";
import { useDayTasks, useNow, usePlans } from "@/features/plans/store";
import { TaskLinkStatic } from "@/features/plans/views/task-link";
import { usePapers } from "@/stores/papers";
import { cn } from "@/lib/utils";
import { inTauri, windowReady } from "@/lib/tauri";

/**
 * 桌面「待办纸片」窗口。
 *
 * 形态目标（对齐 PaperTodo 的「纸片」心智）：一张常驻桌面的小纸条，
 * 一眼看完今天的待办，勾一下就走 —— 不是第二个全屏列表。
 *
 * 与文件栅栏的差别：
 *   - 栅栏是「内容容器」：图标网格 + 分页 + 拖入收集文件
 *   - 纸片是「列表视图」：任务行 + 勾选 + 快速添加
 *   两者共用同一套窗口机制（透明/无边框/置底）与几何持久化思路，
 *   但内容与交互完全不同，所以是独立组件而不是给 FencePanel 加分支。
 */
export function TodoPaperWindow({ date }: { date: string }) {
  return <PaperPanel date={date} />;
}

function PaperPanel({ date }: { date: string }) {
  const { t } = useTranslation();
  const tasks = useDayTasks(date);
  const now = useNow();
  const addTask = usePlans((s) => s.addTask);
  const addTasks = usePlans((s) => s.addTasks);
  const toggleDone = usePlans((s) => s.toggleDone);
  const updateTask = usePlans((s) => s.updateTask);

  const paper = usePapers((s) => s.papers[date]);
  const setGeometry = usePapers((s) => s.setGeometry);
  const setCollapsed = usePapers((s) => s.setCollapsed);
  const setPinned = usePapers((s) => s.setPinned);
  const setOpen = usePapers((s) => s.setOpen);

  const collapsed = paper?.collapsed ?? false;
  const pinned = paper?.pinned ?? false;

  const [input, setInput] = useState("");
  const [hover, setHover] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * 标题栏拖动。
   *
   * 不用 `data-tauri-drag-region`：它把双击实现成「切换最大化」，
   * 而桌面纸片双击标题的合理行为是「什么都不做」（标题就是日期，不可改）。
   * 也用 4px 阈值：不设阈值的话，单击标题栏（想选中/聚焦窗口）会立刻
   * 触发系统拖动，鼠标一动窗口就跑了。
   */
  const startTitleDrag = (e: React.PointerEvent) => {
    if (e.button !== 0 || !inTauri) return;
    if ((e.target as HTMLElement).closest("button,input")) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let dragging = false;
    const el = e.currentTarget as HTMLElement;
    const win = getCurrentWebviewWindow();

    const onMove = (ev: PointerEvent) => {
      if (dragging) return;
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      dragging = true;
      cleanup();
      void win.startDragging().catch(() => undefined);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      el.removeEventListener("pointercancel", cleanup);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    el.addEventListener("pointercancel", cleanup);
  };

  /**
   * 收起态只显示根级任务的前几条。
   *
   * 收起的意义是「省桌面空间」，所以这里刻意**不**展开子树 ——
   * 展开子树会让收起态的高度随数据变化，那就不叫收起了。
   */
  const roots = useMemo(() => childrenOf(tasks, null), [tasks]);
  const visible = collapsed ? roots.slice(0, 3) : roots;
  const doneCount = tasks.filter((task) => task.done).length;

  /** 纸片不显示未来/过去的日期标签，只在非今天时提示（否则「今天」是废话） */
  const isToday = date === fmtDate(new Date());
  const dateLabel = useMemo(() => {
    const d = parseDate(date);
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  }, [date]);

  const submit = () => {
    const v = input.trim();
    if (!v) return;
    if (shouldSplitPaste(v)) {
      const lines = splitPastedLines(v);
      if (lines.length > 1) {
        addTasks(date, null, lines);
        setInput("");
        return;
      }
    }
    addTask(date, null, v);
    setInput("");
  };

  /* ── 窗口几何持久化 ──────────────────────────────────
     与栅栏同一套做法：拖动/缩放结束时把几何写回 store，
     Rust 侧不保存任何窗口状态（单一数据源在前端）。 */

  const persistGeometry = useCallback(async () => {
    if (!inTauri) return;
    try {
      const win = getCurrentWebviewWindow();
      const pos = await win.outerPosition();
      const size = await win.innerSize();
      const factor = await win.scaleFactor();
      // 物理像素 → CSS 像素：不除这个比例，多屏不同 DPI 下坐标会逐次漂移
      setGeometry(date, {
        x: Math.round(pos.x / factor),
        y: Math.round(pos.y / factor),
        w: Math.round(size.width / factor),
        h: Math.round(size.height / factor),
      });
    } catch {
      /* 窗口关闭中，忽略 */
    }
  }, [date, setGeometry]);

  useEffect(() => {
    const onResize = () => void persistGeometry();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [persistGeometry]);

  /*
   * 启动：告诉 Rust 可以显示本窗口了。
   *
   * open_todo_paper 用 `visible(false)` 建窗（防白闪），只有前端调
   * windowReady() 才会 show()。漏掉这一句的症状非常隐蔽：**窗口其实创建成功了、
   * invoke 也不报错、位置尺寸都对，只是永远不显示** —— 从外部看就像「命令没生效」，
   * 而且用「枚举可见窗口」去查根本看不到它（要用 IsWindowVisible 为假的枚举）。
   *
   * 同时监听系统级关闭（Alt+F4 / 任务栏关闭），把 open 落成 false；
   * 只在自己的关闭按钮里写是不够的 —— 那条路径之外关掉的窗口，
   * 下次启动会被「恢复」回来，用户会觉得「关不掉」。
   */
  useEffect(() => {
    void windowReady().catch(() => undefined);
    if (!inTauri) return;
    const win = getCurrentWebviewWindow();
    const unClose = win.onCloseRequested(() => {
      setOpen(date, false);
    });
    return () => {
      void unClose.then((fn) => fn());
    };
  }, [date, setOpen]);

  const togglePin = async () => {
    const next = !pinned;
    setPinned(date, next);
    if (!inTauri) return;
    try {
      await getCurrentWebviewWindow().setAlwaysOnTop(next);
    } catch {
      /* 忽略 */
    }
  };

  const close = async () => {
    // 先落意图再关窗：窗口没了之后这个 WebView 的 JS 也会被销毁，
    // 反过来写就永远写不上，重启后纸片又回来了
    setOpen(date, false);
    if (!inTauri) return;
    try {
      await getCurrentWebviewWindow().close();
    } catch {
      /* 忽略 */
    }
  };

  /**
   * 收起/展开时要同时改窗口高度。
   *
   * 只改 CSS 会出现「内容变短了但窗口还是那么高」——桌面上一块透明区域
   * 照样拦截鼠标，用户点不到下面的东西。所以必须连窗口一起缩。
   */
  const COLLAPSED_H = 116;
  const toggleCollapse = async () => {
    const next = !collapsed;
    setCollapsed(date, next);
    if (!inTauri) return;
    try {
      const win = getCurrentWebviewWindow();
      if (next) {
        await win.setSize(new (await import("@tauri-apps/api/dpi")).LogicalSize(
          (paper?.w ?? 260),
          COLLAPSED_H,
        ));
      } else {
        await win.setSize(new (await import("@tauri-apps/api/dpi")).LogicalSize(
          paper?.w ?? 260,
          paper?.h ?? 360,
        ));
      }
    } catch {
      /* 忽略 */
    }
  };

  return (
    <div
      ref={rootRef}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex h-screen w-screen flex-col overflow-hidden rounded-xl border border-border/70 text-[13px] shadow-[var(--pr-shadow-3)]"
      style={{
        // 半透明纸感：85% 卡片色 + 模糊，桌面内容透出一点点，但文字仍然清晰
        background: "color-mix(in oklch, var(--card) 88%, transparent)",
        backdropFilter: "blur(14px) saturate(1.1)",
      }}
    >
      {/* ── 标题栏：整条可拖，标题双击不改名（与栅栏一致：纸片标题就是日期） ── */}
      <div
        onPointerDown={startTitleDrag}
        className="flex h-9 shrink-0 cursor-default items-center gap-2 border-b border-border/60 px-2.5 select-none"
      >
        <span className="min-w-0 flex-1 truncate font-semibold">
          {isToday ? t("plans.today") : dateLabel}
        </span>
        {tasks.length > 0 && (
          <span className="shrink-0 rounded-full bg-brand/10 px-1.5 text-[10px] font-semibold tabular-nums text-brand">
            {doneCount}/{tasks.length}
          </span>
        )}
        <div className={cn("flex shrink-0 items-center gap-0.5 transition-opacity", hover ? "opacity-100" : "opacity-0")}>
          <IconBtn label={pinned ? t("files.unpin") : t("files.pin")} onClick={() => void togglePin()}>
            {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          </IconBtn>
          <IconBtn
            label={collapsed ? t("plans.expandPaper") : t("plans.collapsePaper")}
            onClick={() => void toggleCollapse()}
          >
            {collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </IconBtn>
          <IconBtn label={t("titlebar.close")} danger onClick={() => void close()}>
            <X className="size-3.5" />
          </IconBtn>
        </div>
      </div>

      {/* ── 任务列表 ── */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {visible.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-muted-foreground/70">
            {t("plans.emptyDay")}
          </p>
        ) : (
          visible.map((task) => (
            <PaperRow
              key={task.id}
              date={date}
              task={task}
              now={now}
              onToggle={() => toggleDone(date, task.id)}
              onEdit={(title) => updateTask(date, task.id, { title })}
            />
          ))
        )}
        {collapsed && roots.length > visible.length && (
          <p className="px-2 py-1 text-[11px] text-muted-foreground/70">
            {t("plans.moreTasks", { count: roots.length - visible.length })}
          </p>
        )}
      </div>

      {/* ── 快速添加：收起态隐藏（收起是为了省空间） ── */}
      {!collapsed && (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-border/60 px-2.5 py-1.5">
          <Plus className="size-3.5 shrink-0 text-brand" strokeWidth={2.4} />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder={t("plans.addPlaceholder")}
            className="w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
          />
        </div>
      )}
    </div>
  );
}

/**
 * 纸片里的一行任务。
 *
 * 刻意不支持内联编辑：纸片是「快速勾选」的场景，双击改名会让
 * 「我以为只是点了两下」变成「不小心改了标题」。
 * 要改名请回主应用 —— 那里有完整的编辑态与撤销。
 */
function PaperRow({
  date,
  task,
  now,
  onToggle,
  onEdit,
}: {
  date: string;
  task: PlanTask;
  now: Date;
  onToggle: () => void;
  onEdit: (title: string) => void;
}) {
  const status = statusOf(task, date, now);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);

  const commit = () => {
    const v = draft.trim();
    if (v && v !== task.title) onEdit(v);
    else setDraft(task.title);
    setEditing(false);
  };

  return (
    <div
      className={cn(
        "group flex min-h-7 items-start gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-surface-hover",
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
          {task.done && <Check className="size-2.5" strokeWidth={3.5} />}
        </span>
      </button>

      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(task.title);
              setEditing(false);
            }
          }}
          className="min-w-0 flex-1 rounded border border-brand/50 bg-card px-1 text-[12px] outline-none"
        />
      ) : (
        <div className="min-w-0 flex-1">
          <span
            onDoubleClick={() => {
              setDraft(task.title);
              setEditing(true);
            }}
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
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  children,
  danger,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "grid size-5 place-items-center rounded text-muted-foreground transition-colors",
        danger
          ? "hover:bg-[var(--close-hover-bg)] hover:text-[var(--close-hover-fg)]"
          : "hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
