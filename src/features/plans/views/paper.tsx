import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, PictureInPicture2, Pin, PinOff, Plus, X } from "lucide-react";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  childrenOf,
  parseDate,
  shouldSplitPaste,
  splitPastedLines,
  type PlanTask,
} from "@/features/plans/types";
import { useDayTasks, useNow, usePlans } from "@/features/plans/store";
import { CapsuleView } from "@/features/plans/views/capsule";
import { IconBtn, PaperRow } from "@/features/plans/views/paper-row";
import { paperGeometryFor, usePapers } from "@/stores/papers";
import { cn } from "@/lib/utils";
import { inTauri, windowReady } from "@/lib/tauri";
import { usePlanCopy } from "@/features/plans/copy";
import { closeDailyTodo, useTaskWindowSettings } from "@/features/plans/window-runtime";
import { StorageAlert } from "@/components/shell/storage-alert";
import { i18n as appI18n, I18nextProvider } from "@/lib/i18n";

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

/**
 * store 是否已完成水合。
 *
 * 「写错会留下粘性标记」的操作（层级就是典型）必须先等水合：
 * 水合前读到的是缺省值，据此写下的东西本身就是待撤销的，
 * 而「写下」和「撤销」两条 async 链交错时落地顺序并不保证。
 */
function usePapersHydrated(): boolean {
  const [ok, setOk] = useState(() => usePapers.persist.hasHydrated());
  useEffect(() => {
    if (usePapers.persist.hasHydrated()) {
      setOk(true);
      return;
    }
    // 刻意不用 useRef 一次性门控：StrictMode 的 effect→cleanup→effect 会让
    // 第二次直接 return，退订后再不重订（本项目在纸片恢复上已经踩过一次）
    return usePapers.persist.onFinishHydration(() => setOk(true));
  }, []);
  return ok;
}

export function TodoPaperWindow({ date }: { date: string }) {
  useTaskWindowSettings();
  const form = usePapers((s) => s.papers[date]?.form) ?? "paper";
  const pinned = usePapers((s) => s.papers[date]?.pinned) ?? false;
  const hydrated = usePapersHydrated();

  /*
   * windowReady / 系统级关闭监听必须留在这一层，不能下沉到各自形态的组件里。
   *
   * open_todo_paper 用 `visible(false)` 建窗（防白闪），只有前端调 windowReady() 才会 show()。
   * 这条一旦放进 PaperPanel，切到胶囊形态时 PaperPanel 根本没挂载 ——
   * 窗口创建成功、invoke 不报错、位置尺寸全对，就是永远不显示，看起来像「点了没反应」。
   *
   * 系统关闭（Alt+F4 / 任务栏）也在这里落 open=false：只在自己的关闭按钮里写是不够的，
   * 那条路径之外关掉的窗口下次启动会被「恢复」回来，用户会觉得「关不掉」。
   */
  useEffect(() => {
    if (!inTauri) return;
    const win = getCurrentWebviewWindow();
    const unClose = win.onCloseRequested((event) => {
      event.preventDefault();
      void closeDailyTodo(date);
    });
    void (async () => {
      await windowReady().catch(() => undefined);
    })();
    return () => {
      void unClose.then((fn) => fn());
    };
    // form 只取挂载那一刻的值：它决定「启动时按哪种形态收尾」，
    // 之后的形态切换由 CapsuleWindow / CapsuleView 负责，不该让这个 effect 重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  /*
   * 这个窗口**唯一**的层级写入点。
   *
   * 为什么必须只有一个：层级由「置顶 / 压底」两个互斥标记决定，而 tao 在
   * WM_WINDOWPOSCHANGING 里对带 ALWAYS_ON_BOTTOM 的窗口会把 hwndInsertAfter
   * 强制改成 HWND_BOTTOM —— 谁最后写入谁说了算，而且一旦留下压底标记，
   * 之后每次窗口移动都会被压回底部（贴边滑动一秒要改十几次位置，更是一路压到底）。
   *
   * 还有一个更隐蔽的坑：这个 effect 在**水合完成之前**就会先用缺省值跑一遍 ——
   * 那时 form 读到的还是 "paper"，于是先落一个「压底」；等水合把 form 改成
   * "capsule" 再落「置顶」。两条 async 链交错时落地顺序并不保证，实测正是它
   * 把刚设好的置顶又压回了底层。症状极具迷惑性：同一份代码，
   * 只开一张纸片时胶囊正常置顶、多开一张就掉回底层。
   *
   * 所以这里加了**水合门闩**：水合完成之前一个字节都不写。form / pinned 都是
   * 响应式的 store 值，水合后会自动重算，不需要各形态组件自己去猜时机；
   * 顺带也修好了「挂载时按持久化的 pinned 恢复一次」这件事
   * （之前漏了，重启后置顶的纸片会悄悄掉回桌面层）。
   */
  useEffect(() => {
    if (!inTauri || !hydrated) return;
    const win = getCurrentWebviewWindow();
    void (async () => {
      // 贴边胶囊必须常驻可见；普通纸片由图钉决定，未置顶时回到桌面层
      const onTop = form === "capsule" || pinned;
      if (onTop) {
        await win.setAlwaysOnBottom(false).catch(() => undefined);
        await win.setAlwaysOnTop(true).catch(() => undefined);
      } else {
        await win.setAlwaysOnTop(false).catch(() => undefined);
        await win.setAlwaysOnBottom(true).catch(() => undefined);
      }
    })();
  }, [form, pinned, hydrated]);

  return <I18nextProvider i18n={appI18n}>{form === "capsule" ? <CapsuleWindow date={date} /> : <PaperPanel date={date} />}</I18nextProvider>;
}

/**
 * 胶囊形态的外壳：只负责**还原窗口**，内容交给 CapsuleView。
 *
 * 为什么还原动作放在这里而不是让 CapsuleView 自己在卸载时做：
 * CapsuleView 一旦卸载，它的 effect 清理函数里再想操作这个窗口已经没意义了，
 * 就算能调也没人保证顺序。所以必须由「还活着的父组件」先把几何/层级/穿透摆回去，
 * **最后**才切形态让它卸载。顺序反过来的症状是：窗口以胶囊状态
 * （294×340、穿透、置顶）永久留在屏幕上，纸片看起来再也回不来了。
 */
function CapsuleWindow({ date }: { date: string }) {
  const paper = usePapers((s) => s.papers[date]);
  const setForm = usePapers((s) => s.setForm);

  const expand = useCallback(async () => {
    if (!inTauri) {
      setForm(date, "paper");
      return;
    }
    const win = getCurrentWebviewWindow();
    const g = paperGeometryFor(date);
    const pinned = paper?.pinned ?? false;
    // 顺序：先能接鼠标 → 再摆回原位 → 再还原层级 → 最后才切形态
    await win.setIgnoreCursorEvents(false).catch(() => undefined);
    await win.setSize(new LogicalSize(g.w, g.h)).catch(() => undefined);
    await win.setPosition(new LogicalPosition(g.x, g.y)).catch(() => undefined);
    /*
     * 还原层级。置顶与压底是**两个互斥标记**，必须成对设置：
     * tao 只看「当前带哪个标记」决定 z 序，而它在 WM_WINDOWPOSCHANGING 里对带
     * ALWAYS_ON_BOTTOM 的窗口会强制 hwndInsertAfter = HWND_BOTTOM ——
     * 纸片窗口本来就是带这个标记创建的，所以只调 setAlwaysOnTop 会被立刻推翻。
     * 详细推导见 CapsuleView 首次挂载处那段注释。
     */
    if (pinned) {
      await win.setAlwaysOnBottom(false).catch(() => undefined);
      await win.setAlwaysOnTop(true).catch(() => undefined);
    } else {
      await win.setAlwaysOnTop(false).catch(() => undefined);
      await win.setAlwaysOnBottom(true).catch(() => undefined);
    }
    setForm(date, "paper");
  }, [date, paper?.pinned, setForm]);

  const close = useCallback(async () => {
    await closeDailyTodo(date);
  }, [date]);

  return <CapsuleView date={date} onExpand={() => void expand()} onClose={() => void close()} />;
}

function PaperPanel({ date }: { date: string }) {
  const { t, i18n } = useTranslation();
  const copy = usePlanCopy();
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
  const setForm = usePapers((s) => s.setForm);

  const collapsed = paper?.collapsed ?? false;
  const pinned = paper?.pinned ?? false;

  const [input, setInput] = useState("");
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

  const dateLabel = useMemo(() => {
    return new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" }).format(parseDate(date));
  }, [date, i18n.language]);

  const renderTask = (task: PlanTask, ancestors: Set<string> = new Set()): React.ReactNode => {
    if (ancestors.has(task.id)) return null;
    const next = new Set(ancestors).add(task.id);
    const children = collapsed ? [] : childrenOf(tasks, task.id);
    return (
      <div key={task.id}>
        <PaperRow date={date} task={task} now={now}
          onToggle={() => toggleDone(date, task.id)}
          onEdit={(title) => updateTask(date, task.id, { title })}
          onTimeChange={(time) => updateTask(date, task.id, time)}
          onAddChild={collapsed ? undefined : (title) => addTask(date, task.id, title)} />
        {children.length > 0 && <div className="daily-paper-tree" style={next.size > 4 ? { marginLeft: 0, paddingLeft: 2 } : undefined}>
          {children.map((child) => renderTask(child, next))}
        </div>}
      </div>
    );
  };

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

  /**
   * 置顶开关只改状态，窗口层级由 TodoPaperWindow 的 effect 统一落。
   *
   * 不在这里顺手调 setAlwaysOnTop：纸片窗口的层级写入点只能有一个 ——
   * 置顶 / 压底是互斥标记，谁最后写入谁说了算，散在两处必然打架
   * （曾经就因此出现「只开一张纸片时置顶正常、多开一张就掉回底层」）。
   */
  const togglePin = () => setPinned(date, !pinned);

  const close = async () => {
    await closeDailyTodo(date);
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
      className="daily-paper flex h-screen w-screen flex-col overflow-hidden rounded-xl border border-border/70 text-[13px] shadow-[var(--workbench-shadow)]"
      style={{
        // 半透明纸感：85% 卡片色 + 模糊，桌面内容透出一点点，但文字仍然清晰
        background: "var(--workbench-glass, var(--card))",
        backdropFilter: "blur(14px) saturate(1.1)",
      }}
    >
      {/* ── 标题栏：整条可拖，标题双击不改名（与栅栏一致：纸片标题就是日期） ── */}
      <div
        onPointerDown={startTitleDrag}
        className="flex h-9 shrink-0 cursor-default items-center gap-2 border-b border-border/60 px-2.5 select-none"
      >
        <span className="min-w-0 flex-1 truncate font-semibold" title={`${date} · ${copy.dailyTodos}`}>
          {dateLabel}
        </span>
        {tasks.length > 0 && (
          <span className="shrink-0 rounded-full bg-brand/10 px-1.5 text-[10px] font-semibold tabular-nums text-brand">
            {doneCount}/{tasks.length}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          <span className={cn("rounded", pinned && "bg-brand/15 text-brand")}>
          <IconBtn pressed={pinned} label={pinned ? copy.unpin : copy.pin} onClick={() => void togglePin()}>
            {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          </IconBtn>
          </span>
          <IconBtn
            label={collapsed ? t("plans.expandPaper") : t("plans.collapsePaper")}
            onClick={() => void toggleCollapse()}
          >
            {collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </IconBtn>
          <IconBtn label={t("plans.capsuleToEdge")} onClick={() => setForm(date, "capsule")}>
            <PictureInPicture2 className="size-3.5" />
          </IconBtn>
          <IconBtn label={copy.close} danger onClick={() => void close()}>
            <X className="size-3.5" />
          </IconBtn>
        </div>
      </div>

      <StorageAlert />

      {/* ── 任务列表 ── */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {visible.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-muted-foreground/70">
            {t("plans.emptyDay")}
          </p>
        ) : (
          visible.map((task) => renderTask(task))
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
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && submit()}
            placeholder={t("plans.addPlaceholder")}
            className="w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
          />
        </div>
      )}
    </div>
  );
}
