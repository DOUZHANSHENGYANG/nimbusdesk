import { invoke } from "@tauri-apps/api/core";
import type { Monitor } from "@tauri-apps/api/window";
import type { MonitorArea } from "./queue-core";

/**
 * 多屏解析层的 FE 入口。
 *
 * 2026-10 起**列表与解析都在 Rust**（`src-tauri/src/display.rs`）：
 * 这里只做一层薄转发 —— 之前这层的「读不到就回退主屏」正是多屏机器上
 * 挂件赖在主屏的根源，已经删除：Rust 侧空列表/找不到屏都返回错误，由调用方处理。
 */
export async function readMonitors(): Promise<MonitorArea[]> {
  return invoke<MonitorArea[]>("display_list").catch(() => []);
}

/** 解析「该在哪块屏」：pref 为空/"auto" 跟随鼠标所在屏，否则按 id 固定（找不到就报错）。 */
export async function resolveMonitor(pref?: string | null): Promise<MonitorArea> {
  return invoke<MonitorArea>("display_resolve", { pref: pref ?? null });
}

/** 兼容旧调用点：把 tauri 的 Monitor 转成 MonitorArea（id 用整屏原点，与 Rust 侧一致）。 */
export function monitorArea(monitor: Monitor): MonitorArea {
  const a = monitor.workArea;
  return { id: `${monitor.name ?? "display"}@${monitor.position.x},${monitor.position.y}`, name: monitor.name ?? undefined, x: a.position.x, y: a.position.y, w: a.size.width, h: a.size.height, scale: monitor.scaleFactor };
}
