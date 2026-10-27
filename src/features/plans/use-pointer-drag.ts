import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 指针拖拽（不是 HTML5 DnD）。
 *
 * 为什么不用 `draggable` + `dataTransfer`：Tauri 的 WebView2 只要 `dragDropEnabled` 为真
 * （默认就是），原生拖放就会把页面内的 HTML5 拖拽接管掉 —— 同一个页面在普通浏览器里能拖，
 * 真机上纹丝不动。而把它关掉又会连带废掉文件页的原生文件拖入（`tauri://drag-drop`），
 * 那个是核心功能，不能拿去换。所以拖拽这一层必须自己走 pointer 事件。
 *
 * 用法：
 *   const drag = usePointerDrag<string>({ hitTest, onDrop });
 *   <div onPointerDown={e => drag.start(e, id)} data-dragging={drag.dragging === id} />
 *   <div data-drop="col" />                        // hitTest 从元素上认目标
 */
export function usePointerDrag<T>({
  hitTest,
  onDrop,
  threshold = 4,
}: {
  /** 从指针下的元素算出放置目标；返回 null 表示这一带不接 */
  hitTest: (element: HTMLElement | null) => string | null;
  onDrop: (payload: T, target: string) => void;
  /** 起拖阈值：小于这个距离当点击，避免抢掉勾选框/按钮的点击 */
  threshold?: number;
}) {
  const [dragging, setDragging] = useState<T | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const payload = useRef<T | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const active = useRef(false);

  const reset = useCallback(() => {
    payload.current = null;
    active.current = false;
    setDragging(null);
    setOver(null);
  }, []);

  useEffect(() => {
    const target = (x: number, y: number) =>
      hitTest(document.elementFromPoint(x, y) as HTMLElement | null);

    const move = (event: PointerEvent) => {
      if (payload.current === null) return;
      if (!active.current) {
        const far = Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y);
        if (far < threshold) return;
        active.current = true;
        setDragging(payload.current);
      }
      const next = target(event.clientX, event.clientY);
      setOver((prev) => (prev === next ? prev : next));
    };

    const up = (event: PointerEvent) => {
      const item = payload.current;
      const wasActive = active.current;
      const next = wasActive ? target(event.clientX, event.clientY) : null;
      reset();
      if (wasActive && item !== null && next !== null) onDrop(item, next);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", reset);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", reset);
    };
  }, [hitTest, onDrop, reset, threshold]);

  const start = useCallback((event: React.PointerEvent, item: T) => {
    if (event.button !== 0) return;
    // 勾选框、按钮、输入框上的按下照旧留给它们自己
    if ((event.target as HTMLElement).closest("button,input,textarea,select,a,[contenteditable='true']")) return;
    payload.current = item;
    origin.current = { x: event.clientX, y: event.clientY };
    active.current = false;
  }, []);

  return { start, dragging, over };
}
