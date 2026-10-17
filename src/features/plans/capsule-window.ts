import { currentMonitor, cursorPosition } from "@tauri-apps/api/window";
import type { WorkArea } from "@/features/plans/capsule";
import { inTauri } from "@/lib/tauri";

/**
 * 胶囊需要的**平台查询**（显示器工作区 / 全局光标）。
 *
 * 与 capsule.ts 分开的理由不是「文件太长」，而是可测性：
 * capsule.ts 里全是可以直接断言几何的纯函数，而这两个必须走 Tauri IPC。
 * 混在一起的直接后果是「想给几何写个测试，得先把整个 Tauri 依赖树拖进来」——
 * 于是几何就没人测了，而几何一旦算错，症状是胶囊跑到屏幕外或卡片永远不出来，
 * 靠手点极难发现。
 */

/**
 * 当前窗口所在显示器的工作区，已是逻辑像素。
 *
 * 必须在**移动窗口之前**调用：它是按窗口当前位置找显示器的，
 * 而胶囊静止时窗口有一半在屏幕外，那之后就找不到正确的显示器了。
 *
 * 取不到就返回 null —— 调用方应当放弃贴边，而不是拿主屏尺寸瞎猜
 * （多显示器下猜错会把胶囊扔到另一块屏幕上）。
 */
export async function workAreaOf(): Promise<WorkArea | null> {
  if (!inTauri) return null;
  try {
    const m = await currentMonitor();
    if (!m) return null;
    const s = m.scaleFactor;
    const p = m.workArea.position.toLogical(s);
    const z = m.workArea.size.toLogical(s);
    return { x: p.x, y: p.y, w: z.width, h: z.height };
  } catch {
    return null;
  }
}

/**
 * 全局光标位置（逻辑像素）。
 *
 * 胶囊静止时窗口设了 ignoreCursorEvents，收不到任何鼠标事件，
 * 判断「鼠标是不是停在滑块上」只剩这一条路。
 *
 * 多显示器不同 DPI 下，这里一律按**胶囊所在显示器**的缩放换算；
 * 光标若在别的屏上，算出来的值偏大/偏小，但结果只会是「没命中」，不会误判成命中。
 */
export async function screenCursor(): Promise<{ x: number; y: number } | null> {
  if (!inTauri) return null;
  try {
    const m = await currentMonitor();
    const s = m?.scaleFactor ?? 1;
    const p = await cursorPosition();
    return { x: p.x / s, y: p.y / s };
  } catch {
    return null;
  }
}
