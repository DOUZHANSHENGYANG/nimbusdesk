type Rect = { x: number; y: number; w: number; h: number };

/** Geometry received from Tauri is physical; the persisted builder input is logical. */
export function logicalFenceGeometry(position: { x: number; y: number }, size: { width: number; height: number }, scale: number): Rect {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return { x: position.x / factor, y: position.y / factor, w: size.width / factor, h: size.height / factor };
}

/** Only an actual title drag can opt into docking, never resize or own programmatic moves. */
export function dragDockEdge(rect: Rect, area: Rect, userDragged: boolean): "left" | "right" | null {
  if (!userDragged) return null;
  const left = Math.abs(rect.x - area.x);
  const right = Math.abs(rect.x + rect.w - area.x - area.w);
  if (Math.min(left, right) > 12) return null;
  return left <= right ? "left" : "right";
}
