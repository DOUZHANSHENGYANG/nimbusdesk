import { availableMonitors, currentMonitor, primaryMonitor, type Monitor } from "@tauri-apps/api/window";
import type { MonitorArea } from "./queue-core";

export function monitorArea(monitor: Monitor): MonitorArea {
  const a = monitor.workArea;
  return { id: `${monitor.name ?? "display"}@${monitor.position.x},${monitor.position.y}`, name: monitor.name ?? undefined, x: a.position.x, y: a.position.y, w: a.size.width, h: a.size.height, scale: monitor.scaleFactor };
}
export async function readMonitors(): Promise<MonitorArea[]> {
  const available = await availableMonitors();
  if (available.length) return available.map(monitorArea);
  const fallback = await currentMonitor() ?? await primaryMonitor();
  return fallback ? [monitorArea(fallback)] : [];
}
