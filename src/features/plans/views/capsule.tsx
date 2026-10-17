import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight, Maximize2, X } from "lucide-react";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  CAPSULE_CARD_H,
  CAPSULE_CARD_W,
  CAPSULE_EXIT_MS,
  CAPSULE_HOVER_MS,
  CAPSULE_PILL_H,
  CAPSULE_POLL_MS,
  CAPSULE_RADIUS,
  CAPSULE_SLIDE_MS,
  CAPSULE_SLIVER,
  CAPSULE_WIN_H,
  CAPSULE_WIN_W,
  capsulePillScreenRect,
  capsuleRectAt,
  defaultEdgeY,
  edgeYFromDrag,
  flattenTree,
  pillInnerX,
  rectContains,
  slotEdgeY,
  type CapsuleEdge,
  type WorkArea,
} from "@/features/plans/capsule";
import { screenCursor, workAreaOf } from "@/features/plans/capsule-window";
import { fmtDate, parseDate } from "@/features/plans/types";
import { useDayTasks, useNow, usePlans } from "@/features/plans/store";
import { IconBtn, PaperRow } from "@/features/plans/views/paper-row";
import { usePapers } from "@/stores/papers";
import { gsap } from "@/lib/gsap";
import { inTauri } from "@/lib/tauri";

/**
 * 贴边胶囊形态的纸片窗口内容。
 *
 * 触发方式是「窗口已经就位，只是换了内容」：paper.tsx 把 form 改成 "capsule"，
 * 本组件挂载后**自己**把窗口尺寸/位置/层级/穿透一次性摆好（见下面的 mount effect），
 * 于是所有窗口操作只有这一个出口，不会出现「父组件摆一半、子组件摆一半」的拉锯。
 *
 * 三条关键设计：
 *   1. 静止时窗口是**穿透**的（ignoreCursorEvents）。理由：窗口静态时有
 *      `280 × 340` 是「透明但能接鼠标」的区域，不穿透就等于在屏幕边上贴了一块
 *      280×340 的隐形挡板，底下的滚动条、关闭按钮全点不到。代价是收不到鼠标事件，
 *      于是悬停判断改走 `screenCursor()` 轮询全局光标（步骤见 CAPSULE_POLL_MS）。
 *   2. 展开只**挪窗口**，从不改尺寸。WebView2 下每帧改尺寸会触发重排 + 同步重绘，
 *      必卡；挪窗口是纯定位，160ms 十几次 IPC 就能跟手。
 *   3. 滑块在窗口内反向平移，使它在**屏幕坐标上不动** —— 观感是卡片从滑块后面
 *      抽出来，而不是整条东西一起跑。
 */
export function CapsuleView({
  date,
  onExpand,
  onClose,
}: {
  date: string;
  /** 展开回普通纸片（父组件负责把窗口几何/层级还原） */
  onExpand: () => void;
  /** 彻底关掉这张纸片 */
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const tasks = useDayTasks(date);
  const now = useNow();
  const toggleDone = usePlans((s) => s.toggleDone);
  const updateTask = usePlans((s) => s.updateTask);

  const stored = usePapers((s) => s.papers[date]);
  const setEdgeStore = usePapers((s) => s.setEdge);
  const setEdgeYStore = usePapers((s) => s.setEdgeY);

  const [ready, setReady] = useState(false);
  const [edge, setEdge] = useState<CapsuleEdge>(stored?.edge ?? "right");

  /* 动画相关的量全走 ref：滑出是 60fps 的命令式过程，
     走 state 会让整张卡（含任务列表）每帧重渲染一遍。 */
  const waRef = useRef<WorkArea | null>(null);
  const edgeYRef = useRef(0);
  const edgeRef = useRef<CapsuleEdge>(edge);
  const progressRef = useRef(0);
  const openRef = useRef(false);
  const dragRef = useRef(false);
  const aliveRef = useRef(true);
  const pillRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const tweenRef = useRef<gsap.core.Tween | null>(null);
  const exitTimerRef = useRef<number | undefined>(undefined);
  const expandedDetails = useRef(new Set<string>());

  edgeRef.current = edge;

  const rows = useMemo(() => flattenTree(tasks), [tasks]);
  const doneCount = tasks.filter((task) => task.done).length;
  const isToday = date === fmtDate(new Date());
  const dateLabel = useMemo(() => {
    const d = parseDate(date);
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  }, [date]);

  /**
   * 把「滑出进度」写进现实：窗口位置 + 滑块反向平移 + 卡片透明度。
   *
   * 三者必须在同一帧写，否则会出现「卡片已经露出来但滑块还在原地」的错位。
   */
  const apply = useCallback((p: number) => {
    progressRef.current = p;
    const wa = waRef.current;
    if (!wa) return;
    const edge = edgeRef.current;
    const rect = capsuleRectAt(wa, edge, edgeYRef.current, p);
    // 窗口只能落在整数逻辑像素上；滑块偏移由**这个** x 反推而不是按进度算，
    // 否则窗口的量化误差会在滑动中累积成滑块抖动（见 capsule.ts 的 pillInnerX）
    const x = Math.round(rect.x);
    if (inTauri) {
      // 不 await：这是每帧一次的定位，排队等回包反而会拖后腿
      void getCurrentWebviewWindow()
        .setPosition(new LogicalPosition(x, rect.y))
        .catch(() => undefined);
    }
    const pill = pillRef.current;
    if (pill) {
      // 滑块该待的屏幕位置只由「贴哪一边」决定，与进度无关 —— 这才是「卡片从它后面抽出来」
      const pillX = capsulePillScreenRect(wa, edge, edgeYRef.current).x;
      pill.style.transform = `translateX(${pillInnerX(pillX, x)}px)`;
    }
    const card = cardRef.current;
    if (card) {
      /*
       * 静止时卡片必须完全不可见。
       *
       * 窗口在静止位置时有 280px 探出**工作区**之外；任务栏停靠在左/右时，
       * 那一段其实还在屏幕内、会盖在任务栏上。常量 3 让它在 p≈0.33 就完全不透明，
       * 也就是「一开始滑就已经看得见」，不做成渐显效果。
       */
      card.style.opacity = String(Math.min(1, p * 3));
    }
  }, []);

  const slideTo = useCallback(
    (target: number, onDone?: () => void) => {
      tweenRef.current?.kill();
      const from = progressRef.current;
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (reduce || Math.abs(target - from) < 0.001) {
        apply(target);
        tweenRef.current = null;
        onDone?.();
        return;
      }
      const proxy = { p: from };
      tweenRef.current = gsap.to(proxy, {
        p: target,
        // 时长按距离缩放：半途收回时不该还是整整 160ms
        duration: (CAPSULE_SLIDE_MS / 1000) * Math.abs(target - from),
        ease: "power2.out",
        onUpdate: () => apply(proxy.p),
        onComplete: () => {
          apply(target);
          tweenRef.current = null;
          onDone?.();
        },
      });
    },
    [apply],
  );

  /* ── 悬停展开 / 收回 ─────────────────────────────────── */

  const openPreview = useCallback(async () => {
    if (openRef.current || dragRef.current || !aliveRef.current) return;
    openRef.current = true;
    // 先解除穿透，再滑出：滑出途中光标就该能落到卡片上，
    // 反过来的话「鼠标跟着卡片走」这段会落在穿透区里，感觉像卡了一下
    await getCurrentWebviewWindow().setIgnoreCursorEvents(false).catch(() => undefined);
    if (!aliveRef.current) return;
    slideTo(1);
  }, [slideTo]);

  const closePreview = useCallback(() => {
    if (!openRef.current || expandedDetails.current.size) return;
    openRef.current = false;
    slideTo(0, () => {
      // 收回到位之后才恢复穿透，否则收回动画期间窗口还挡着底下的东西
      if (!aliveRef.current || openRef.current) return;
      void getCurrentWebviewWindow().setIgnoreCursorEvents(true).catch(() => undefined);
    });
  }, [slideTo]);

  /* ── 离开卡片后延迟收回 ─────────────────────────────── */

  const cancelExit = () => {
    if (exitTimerRef.current !== undefined) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = undefined;
    }
  };

  /** 鼠标离开卡片：不立刻收，等 CAPSULE_EXIT_MS（PaperTodo 的 1000ms） */
  const onLeave = () => {
    if (dragRef.current || expandedDetails.current.size) return;
    cancelExit();
    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = undefined;
      closePreview();
    }, CAPSULE_EXIT_MS);
  };

  /* ── 挂载：一次性把窗口摆成胶囊 ────────────────────────── */
  useEffect(() => {
    aliveRef.current = true;
    void (async () => {
      if (!inTauri) {
        // 非 Tauri（浏览器里看样式）时没有窗口可操作，直接把卡片摆成全展开态
        waRef.current = { x: 0, y: 0, w: 1280, h: 800 };
        edgeYRef.current = defaultEdgeY(waRef.current);
        setReady(true);
        apply(1);
        return;
      }
      const win = getCurrentWebviewWindow();
      /*
       * 第一件事就是穿透。此刻窗口还停在纸片原位，很可能正好在光标底下，
       * 不先穿透的话会产生一串 hover 事件，把「悬停→展开」的状态机提前打乱。
       */
      await win.setIgnoreCursorEvents(true).catch(() => undefined);

      const wa = await workAreaOf();
      if (!aliveRef.current) return;
      if (!wa) {
        /*
         * 取不到工作区就退回纸片形态。
         *
         * 不能「什么都不做」：那时窗口还停在纸片原位，而本组件已经把根节点
         * opacity 设成 0、窗口设成穿透 —— 用户看到的是纸片凭空消失、还点不到，
         * 比不贴边糟糕得多。
         */
        await win.setIgnoreCursorEvents(false).catch(() => undefined);
        usePapers.getState().setForm(date, "paper");
        return;
      }

      const e0: CapsuleEdge = stored?.edge ?? "right";
      /*
       * 没落过位的胶囊按这一侧已有几个来挑槽位（48 + 50n）。
       *
       * 不能所有胶囊都用 defaultEdgeY：贴第二张纸片时会精确压在第一个胶囊上，
       * 用户看到的是「第一次贴的没生效」，而不是「多了一个」。
       */
      const sameSide = Object.values(usePapers.getState().papers).filter(
        (p) => p.form === "capsule" && (p.edge ?? "right") === e0 && typeof p.edgeY === "number",
      ).length;
      const y0 = stored?.edgeY ?? slotEdgeY(wa, sameSide);
      waRef.current = wa;
      edgeYRef.current = y0;
      edgeRef.current = e0;

      const rect = capsuleRectAt(wa, e0, y0, 0);
      await win.setSize(new LogicalSize(CAPSULE_WIN_W, CAPSULE_WIN_H)).catch(() => undefined);
      await win.setPosition(new LogicalPosition(rect.x, rect.y)).catch(() => undefined);
      /*
       * 层级**不在**这里设置：这个窗口只有一个层级写入点，在 TodoPaperWindow 里。
       * 那里有完整理由（tao 的 WM_WINDOWPOSCHANGING 会对带 ALWAYS_ON_BOTTOM 标记的窗口
       * 强制压底；以及 form / pinned 是响应式值，水合完成后会自动重算）。
       */
      if (!aliveRef.current) return;
      apply(0);
      setReady(true);
    })();
    return () => {
      aliveRef.current = false;
      tweenRef.current?.kill();
      tweenRef.current = null;
      if (exitTimerRef.current !== undefined) window.clearTimeout(exitTimerRef.current);
    };
    // stored 只在挂载那一刻当初始值用，之后由本组件的操作写回，
    // 放进依赖会让每次落盘都重跑一遍窗口摆放（会跟用户拖动打架）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  /* ── 静止时的悬停检测：窗口穿透，只能轮询全局光标 ───────── */
  useEffect(() => {
    if (!ready) return;
    let stop = false;
    let dwell: number | undefined;

    const tick = async () => {
      if (stop || openRef.current || dragRef.current) return;
      const wa = waRef.current;
      if (!wa) return;
      const c = await screenCursor();
      if (stop || openRef.current || dragRef.current) return;
      const pill = capsulePillScreenRect(wa, edgeRef.current, edgeYRef.current);
      const inside = !!c && rectContains(pill, c.x, c.y, 2);
      if (inside) {
        // 「悬停意图」：先停够 CAPSULE_HOVER_MS 才算想停，路过不算
        if (dwell === undefined) {
          dwell = window.setTimeout(() => {
            dwell = undefined;
            void openPreview();
          }, CAPSULE_HOVER_MS);
        }
      } else if (dwell !== undefined) {
        window.clearTimeout(dwell);
        dwell = undefined;
      }
    };

    const id = window.setInterval(() => void tick(), CAPSULE_POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(id);
      if (dwell !== undefined) window.clearTimeout(dwell);
    };
  }, [ready, openPreview]);

  /* ── 沿边上下拖动 ──────────────────────────────────── */

  const startEdgeDrag = (e: React.PointerEvent) => {
    const wa = waRef.current;
    if (e.button !== 0 || !wa || !inTauri) return;
    // 标题栏上的按钮不参与拖动，否则点「换边」会变成拖窗口
    if ((e.target as HTMLElement).closest("button,input")) return;

    const el = e.currentTarget as HTMLElement;
    const startScreenY = e.screenY;
    const startEdgeY = edgeYRef.current;
    // 抓取点相对药丸顶部的偏移：拖动全程不变，光标才不会「吸」到药丸顶端
    const grabOffset = startScreenY - wa.y - startEdgeY;
    let moved = false;
    dragRef.current = true;
    cancelExit();
    el.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.screenY - startScreenY) < 3) return;
      moved = true;
      edgeYRef.current = edgeYFromDrag(wa, ev.screenY, grabOffset);
      apply(progressRef.current);
    };
    const onUp = () => {
      dragRef.current = false;
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      if (moved) setEdgeYStore(date, edgeYRef.current);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  /* ── 换边 ──────────────────────────────────────────── */

  const switchEdge = async () => {
    if (!waRef.current) return;
    const next: CapsuleEdge = edgeRef.current === "right" ? "left" : "right";
    // 换边时先收起：展开态下换边，滑动方向与滑块基准同时翻转，直接收干净最省事
    cancelExit();
    openRef.current = false;
    edgeRef.current = next;
    setEdge(next);
    setEdgeStore(date, next);
    progressRef.current = 0;
    apply(0);
    await getCurrentWebviewWindow().setIgnoreCursorEvents(true).catch(() => undefined);
  };

  /*
   * React 每次重渲染会重写 style 里它管理的那些属性。transform 不在 style prop 里，
   * 正常不会被碰；但换边会改变滑块的圆角/基准，为稳妥在渲染后按当前进度重放一次。
   */
  useEffect(() => {
    if (ready) apply(progressRef.current);
  }, [edge, ready, apply]);

  /* ── 渲染 ─────────────────────────────────────────── */

  const pillRadius =
    edge === "right"
      ? `${CAPSULE_RADIUS}px 0 0 ${CAPSULE_RADIUS}px`
      : `0 ${CAPSULE_RADIUS}px ${CAPSULE_RADIUS}px 0`;
  const pillAccent = edge === "right" ? "left" : "right";

  return (
    <div
      className="relative h-screen w-screen overflow-hidden"
      style={{ opacity: ready ? 1 : 0 }}
      onMouseEnter={cancelExit}
      onMouseLeave={onLeave}
    >
      {/* ── 预览卡：窗口内的 0..280，静止时整块都在屏幕外 ── */}
      <div
        ref={cardRef}
        style={{ position: "absolute", left: 0, top: 0, width: CAPSULE_CARD_W, height: CAPSULE_CARD_H, opacity: 0 }}
        className="flex flex-col overflow-hidden rounded-xl border border-border/70 text-[13px] shadow-[var(--pr-shadow-3)]"
      >
        <div
          style={{
            background: "color-mix(in oklch, var(--card) 88%, transparent)",
            backdropFilter: "blur(14px) saturate(1.1)",
          }}
          className="flex h-full flex-col"
        >
          {/* 标题栏：按住可沿边上下拖动定位 */}
          <div
            onPointerDown={startEdgeDrag}
            className="flex h-9 shrink-0 cursor-default items-center gap-1.5 border-b border-border/60 px-2.5 select-none"
          >
            <span className="min-w-0 flex-1 truncate font-semibold">
              {isToday ? t("plans.today") : dateLabel}
            </span>
            {tasks.length > 0 && (
              <span className="shrink-0 rounded-full bg-brand/10 px-1.5 text-[10px] font-semibold tabular-nums text-brand">
                {doneCount}/{tasks.length}
              </span>
            )}
            <div className="flex shrink-0 items-center gap-0.5">
              <IconBtn label={t("plans.capsuleSwitchEdge")} onClick={() => void switchEdge()}>
                <ArrowLeftRight className="size-3.5" />
              </IconBtn>
              <IconBtn label={t("plans.capsuleExpand")} onClick={onExpand}>
                <Maximize2 className="size-3.5" />
              </IconBtn>
              <IconBtn label={t("titlebar.close")} danger onClick={onClose}>
                <X className="size-3.5" />
              </IconBtn>
            </div>
          </div>

          {/* 任务列表：直接勾选 + 滚轮滚动；点空白处展开为完整纸片 */}
          <div
            className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5"
            onClick={(e) => {
              if (e.target === e.currentTarget) onExpand();
            }}
          >
            {rows.length === 0 ? (
              <p className="px-2 py-8 text-center text-[12px] text-muted-foreground/70">
                {t("plans.emptyDay")}
              </p>
            ) : (
              rows.map(({ task, depth }) => (
                <PaperRow
                  key={task.id}
                  date={date}
                  task={task}
                  now={now}
                  depth={depth}
                  editable={false}
                  onToggle={() => toggleDone(date, task.id)}
                  onEdit={(title) => updateTask(date, task.id, { title })}
                  onTimeChange={(time) => updateTask(date, task.id, time)}
                  onDetailsChange={(open) => { if (open) expandedDetails.current.add(task.id); else expandedDetails.current.delete(task.id); cancelExit(); }}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {/* ── 贴边滑块：屏幕上的全部可见部分就是它 ── */}
      <div
        ref={pillRef}
        onClick={() => {
          if (openRef.current) onExpand();
        }}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: CAPSULE_SLIVER,
          height: CAPSULE_PILL_H,
          borderRadius: pillRadius,
          background: "color-mix(in oklch, var(--card) 88%, transparent)",
          backdropFilter: "blur(14px) saturate(1.1)",
        }}
        className="border border-border/70"
        title={t("plans.capsuleHint")}
      >
        {/* 靠屏幕内侧的一道品牌色细线：14px 的宽度里，这是唯一能被认出的特征 */}
        <span
          style={{
            position: "absolute",
            top: 8,
            bottom: 8,
            width: 2,
            borderRadius: 2,
            [pillAccent]: 4,
          }}
          className="bg-brand/70"
        />
      </div>
    </div>
  );
}
