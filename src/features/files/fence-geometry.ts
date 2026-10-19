type Rect = { x: number; y: number; w: number; h: number };

/** Geometry received from Tauri is physical; the persisted builder input is logical. */
export function logicalFenceGeometry(position: { x: number; y: number }, size: { width: number; height: number }, scale: number): Rect {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return { x: position.x / factor, y: position.y / factor, w: size.width / factor, h: size.height / factor };
}

/** Only an actual title drag can opt into docking, never resize or own programmatic moves. */
export function dragDockEdge(rect: Rect, area: Rect, userDragged: boolean): "left" | "right" | "top" | null {
  if (!userDragged) return null;
  const left = Math.abs(rect.x - area.x);
  const right = Math.abs(rect.x + rect.w - area.x - area.w);
  const top = Math.abs(rect.y - area.y);
  if (Math.min(left, right, top) > 12) return null;
  if (top < Math.min(left, right)) return "top";
  return left <= right ? "left" : "right";
}
