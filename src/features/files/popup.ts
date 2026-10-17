import { useEffect, useRef, useState } from "react";
import { emit, emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { MenuNode } from "@/features/files/menu-model";
import {
  inTauri,
  hidePopupMenu,
  showPopupMenu,
  preparePopupMenu,
} from "@/lib/tauri";

/**
 * 右键菜单浮窗通信。
 *
 * 背景：菜单要能溢出栅栏窗口边界，而 WebView 内的 DOM 无法超出自身窗口，
 * 所以菜单由独立的无边框置顶小窗承载。打开方（栅栏/主窗口）通过事件
 * 把「要渲染哪个菜单」发给浮窗，浮窗渲染完把实际尺寸回报，
 * 打开方据此定位并显示窗口（先渲染后显示，避免尺寸跳动）。
 *
 * 三个关键约束（都踩过）：
 * 1. 监听必须显式声明 target。Tauri 的 emit_to 用
 *    `*target == Any || filter(target)` 判断投递，未声明 target 的监听注册为
 *    `Any` 会短路成「总是投递」—— 即 emit_to 依旧会广播到所有窗口。
 *    所以打开方按自己的 label 监听，浮窗按 POPUP_LABEL 监听。
 * 2. 序号要在注册监听之前分配。浮窗是复用的，第二次打开时它已预热，
 *    尺寸回报可能早于监听注册 —— 那样菜单永远不显示。
 * 3. 菜单树是纯数据、已翻译：浮窗不订阅 store，避免两窗口水合时序不一致。
 */

/** 浮窗 label，需与 Rust 侧 POPUP_LABEL 保持一致 */
export const POPUP_LABEL = "popup-menu";

/**
 * 菜单请求载荷：由打开方发往浮窗。
 * 刻意做成自包含的纯数据 —— 浮窗不订阅任何 store，
 * 避免两个窗口水合时序不一致导致菜单显示错数据。
 */
export interface MenuPayload {
  /** 请求序号：浮窗回报尺寸/动作时带回，用于丢弃过期消息 */
  seq: number;
  /** 发起方窗口 label：回报与动作只发回给它 */
  owner: string;
  /** 已翻译好的菜单树 */
  nodes: MenuNode[];
  /** 语言与主题，保证浮窗与打开方一致 */
  lang: string;
  theme: string;
}

/** 浮窗回报：实际渲染尺寸（CSS 像素，含已展开的子菜单列） */
export interface MenuSized {
  seq: number;
  w: number;
  h: number;
}

/** 浮窗请求执行动作（由打开方执行，保证动作上下文正确） */
export interface MenuAction {
  /** 动作名，由打开方解释 */
  action: string;
  /** 动作附带的值（如新建扩展名） */
  value?: string;
}

const EV_OPEN = "popup-menu://open";
const EV_SIZED = "popup-menu://sized";
const EV_CLOSE = "popup-menu://close";
const EV_ACTION = "popup-menu://action";

let seqCounter = 0;

/** 当前窗口 label，作为菜单归属标识 */
export function ownerLabel(): string {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "main"; // 浏览器 pnpm dev 调试
  }
}

/**
 * 取一个新的请求序号。
 * 必须与「注册尺寸监听」分离：序号要在注册之前拿到，
 * 否则浮窗已预热时回报会早于监听注册，菜单永远等不到尺寸。
 */
export function beginMenu(): number {
  return ++seqCounter;
}

/** 打开方：把菜单树发给浮窗渲染（此时浮窗仍隐藏） */
export async function emitMenuRequest(
  seq: number,
  owner: string,
  nodes: MenuNode[],
  lang: string,
  theme: string,
): Promise<void> {
  await emitTo(POPUP_LABEL, EV_OPEN, { seq, owner, nodes, lang, theme } satisfies MenuPayload);
}

/**
 * 打开方：订阅浮窗尺寸回报。
 * 可多次触发 —— 展开子菜单后尺寸变大，需要重新定位并放大窗口。
 */
export function subscribeMenuSize(
  seq: number,
  cb: (s: MenuSized) => void,
): Promise<UnlistenFn> {
  return listen<MenuSized>(
    EV_SIZED,
    (e) => {
      if (e.payload.seq === seq) cb(e.payload);
    },
    { target: ownerLabel() },
  );
}

/**
 * 打开方：按锚点 + 实际尺寸定位并显示浮窗。
 *
 * 锚点是「视口内 CSS 像素」（来自 clientX/clientY），而窗口位置是屏幕坐标，
 * 两者差一个窗口原点 —— 必须加上 innerPosition（换算成逻辑像素），
 * 否则菜单会跑到屏幕左上角附近。
 *
 * 翻转/夹取交给 Rust 侧（按光标所在显示器的工作区处理）：
 * 打开方自己的视口可能很小（栅栏窗口就几百像素），用它做翻转判断会
 * 把菜单当成「越界」而错误地翻到左边。
 */
export async function revealMenu(
  anchor: { x: number; y: number; w: number; h: number },
  size: { w: number; h: number },
  valid: () => boolean = () => true,
): Promise<void> {
  if (!valid()) return;
  const win = getCurrentWebviewWindow();
  const [pos, sf] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
  // Position IPC may finish after blur/Escape, owner unmount or another menu
  // request. Never turn an already dismissed owner back into a visible popup.
  if (!valid()) return;
  const ox = pos.x / sf; // 窗口原点（屏幕逻辑像素）
  const oy = pos.y / sf;

  await showPopupMenu(ox + anchor.x, oy + anchor.y, size.w, size.h);
}

/**
 * 打开方：关闭菜单。
 *
 * 只发事件、不直接调 hide：多个窗口可能同时持有菜单，
 * 无条件 hide 会把别的窗口刚打开的菜单一起关掉。
 * 由浮窗校验 owner 后自行隐藏。
 */
export async function closeMenu(owner: string): Promise<void> {
  await emitTo(POPUP_LABEL, EV_CLOSE, { owner }).catch(() => undefined);
}

/** 浮窗：订阅打开请求与关闭请求 */
export function useMenuHost(onOpen: (p: MenuPayload) => void, onClose: () => void): void {
  // 用 ref 持有回调：effect 只订阅一次，避免重订阅期间漏事件
  const openRef = useRef(onOpen);
  const closeRef = useRef(onClose);
  openRef.current = onOpen;
  closeRef.current = onClose;
  const ownerRef = useRef<string | null>(null);

  useEffect(() => {
    if (!inTauri) return;
    const unOpen = listen<MenuPayload>(
      EV_OPEN,
      (e) => {
        // The shared host can be claimed by another fence/main window. Tell the
        // previous owner so its edge-card menu hold cannot remain latched forever.
        const previous = ownerRef.current;
        if (previous && previous !== e.payload.owner) {
          void sendMenuAction(previous, { action: "close" }).catch(() => undefined);
        }
        ownerRef.current = e.payload.owner;
        openRef.current(e.payload);
      },
      { target: POPUP_LABEL },
    );
    const unClose = listen<{ owner?: string }>(
      EV_CLOSE,
      (e) => {
        const o = e.payload?.owner;
        if (o && ownerRef.current && o !== ownerRef.current) return; // 不是发给本次菜单的
        ownerRef.current = null;
        closeRef.current();
        // 浮窗自己隐藏：打开方不直接 hide，否则会误关别的窗口刚打开的菜单
        void hidePopupMenu().catch(() => undefined);
      },
      { target: POPUP_LABEL },
    );
    return () => {
      if (ownerRef.current) void sendMenuAction(ownerRef.current, { action: "close" }).catch(() => undefined);
      void unOpen.then((fn) => fn());
      void unClose.then((fn) => fn());
    };
  }, []);
}

/** 浮窗：渲染完成后回报尺寸（含已展开的子菜单列） */
export async function reportMenuSize(
  seq: number,
  owner: string,
  w: number,
  h: number,
): Promise<void> {
  await emitTo(owner, EV_SIZED, { seq, w, h } satisfies MenuSized);
}

/** 浮窗：把用户点击的动作定向发回打开方 */
export async function sendMenuAction(owner: string, action: MenuAction): Promise<void> {
  await emitTo(owner, EV_ACTION, action);
}

/** 打开方：接收浮窗发来的动作 */
export function useMenuActions(handler: (a: MenuAction) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!inTauri) return;
    const un = listen<MenuAction>(EV_ACTION, (e) => ref.current(e.payload), {
      target: ownerLabel(),
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, []);
}

/** 判断当前窗口是否是菜单浮窗 */
export function isPopupWindow(): boolean {
  try {
    return getCurrentWebviewWindow().label === POPUP_LABEL;
  } catch {
    return false;
  }
}

/**
 * 就绪握手。
 *
 * 为什么需要它：事件只能投递给「已存在且已注册监听」的 WebView。
 * 浮窗是懒创建的，首次打开时若直接发菜单数据，前端还没挂载完 → 事件丢失 → 菜单不显示。
 *
 * 两个方向都要覆盖：
 * - 浮窗尚未创建：它挂载后会主动广播 ready。
 * - 浮窗早已挂载（别的窗口开过菜单）：不会再广播，所以要 ping 它，由它回 ready。
 */
const EV_READY = "popup-menu://ready";
const EV_PING = "popup-menu://ping";

let popupReady = false;
let readyListenerInstalled = false;

/** 浮窗：监听已就绪，广播通知所有打开方可以发菜单数据了 */
export async function markPopupReady(): Promise<void> {
  if (!inTauri) return;
  // 必须广播而非 emitTo：打开方的监听声明了自己的 label 作为 target，
  // 而 emit_to 按 label 精确过滤，定向发送会匹配不到打开方的监听。
  await emit(EV_READY).catch(() => undefined);
}

/** 浮窗：订阅「是否已就绪」的询问，收到即回 ready */
export function useReadyResponder(): void {
  useEffect(() => {
    if (!inTauri) return;
    const un = listen(EV_PING, () => void markPopupReady(), { target: POPUP_LABEL });
    return () => {
      void un.then((fn) => fn());
    };
  }, []);
}

/**
 * 打开方：确保浮窗存在且已就绪。
 * 首次调用创建窗口并等 ready；之后直接返回（浮窗被复用，只 hide 不销毁）。
 *
 * 返回是否就绪。即便超时也返回（调用方仍会发菜单，由 1.5s 兜底关闭），
 * 但顺序上必须等监听真正注册完成再 ping —— listen() 是异步的，
 * 不 await 就 ping，新建窗口的 ready 可能早于监听注册而被丢弃。
 */
export async function ensurePopupReady(timeoutMs = 3000): Promise<boolean> {
  if (!inTauri) return false;
  if (popupReady) return true;

  if (!readyListenerInstalled) {
    readyListenerInstalled = true;
    // 关键：await，确保 ready 监听已注册再往下走
    await listen(EV_READY, () => {
      popupReady = true;
    }).catch(() => undefined);
  }

  // 先 ping（覆盖「浮窗已挂载」），再确保存在（覆盖「尚未创建」）。
  // 顺序不能反：若先创建再 ping，新建窗口还没挂载，ping 会被丢掉。
  await emitTo(POPUP_LABEL, EV_PING).catch(() => undefined);
  await preparePopupMenu().catch(() => undefined);
  if (popupReady) return true;

  // 等待期间持续重发 ping。这不是冗余：
  // listen() 是异步注册的，新建窗口广播 ready 时它的 EV_OPEN 监听可能还没装好；
  // 而浮窗里 useReadyResponder 的 ping 监听挂在 useMenuHost 之后，
  // 所以「收到 ping 回应」就等价于「EV_OPEN 监听已就绪」——以此为准才可靠。
  await new Promise<void>((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (popupReady || Date.now() - t0 > timeoutMs) {
        resolve();
        return;
      }
      void emitTo(POPUP_LABEL, EV_PING).catch(() => undefined);
      window.setTimeout(tick, 60);
    };
    tick();
  });
  return popupReady;
}

/**
 * 浮窗内容外接尺寸测量。
 *
 * 两个必须注意的点：
 * 1. 子菜单是绝对定位的，不在父元素盒模型内，所以要取所有菜单列
 *    （[data-menu-col]）的外接矩形并集；否则窗口只按主菜单尺寸创建，子菜单会被裁掉。
 * 2. 不能用 requestAnimationFrame 触发测量。浮窗在拿到尺寸前一直是隐藏的
 *    （visible:false，等回报后才 show），而 WebView2 在窗口不可见时不派发 rAF
 *    —— 等 rAF 再测量会死锁在「不显示 → 不测量 → 不显示」。
 *    改用同步测量 + setTimeout 补测 + 字体就绪后补测。
 *
 * 返回值带 key（= 传入的 version）：调用方据此确认「这次尺寸是当前菜单的」，
 * 避免换了菜单后先回报上一份尺寸，导致窗口按旧尺寸定位。
 *
 * @param version 变化时重新测量（换菜单、子菜单展开/收起都要变）
 */
export function useMenuBounds(
  ref: React.RefObject<HTMLElement | null>,
  version: unknown,
): { w: number; h: number; key: unknown } {
  const [size, setSize] = useState<{ w: number; h: number; key: unknown }>({
    w: 0,
    h: 0,
    key: null,
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const base = el.getBoundingClientRect();
      let w = base.width;
      let h = base.height;
      el.querySelectorAll("[data-menu-col]").forEach((c) => {
        const r = (c as HTMLElement).getBoundingClientRect();
        w = Math.max(w, r.right - base.left);
        h = Math.max(h, r.bottom - base.top);
      });
      const nw = Math.ceil(w);
      const nh = Math.ceil(h);
      if (nw <= 0 || nh <= 0) return;
      setSize((p) =>
        p.w === nw && p.h === nh && p.key === version ? p : { w: nw, h: nh, key: version },
      );
    };

    measure(); // 同步首测（getBoundingClientRect 强制布局，不依赖帧）
    const t1 = window.setTimeout(measure, 0);
    const t2 = window.setTimeout(measure, 80); // 字体/换行稳定后补测
    void document.fonts?.ready.then(measure).catch(() => undefined);

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      ro.disconnect();
    };
  }, [ref, version]);

  return size;
}
