import { splitPastedLines, type PlanTask } from "@/features/plans/types";

interface PaperKey {
  key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean;
  altKey?: boolean; isComposing?: boolean; keyCode?: number; repeat?: boolean;
}
interface PaperInteraction {
  editable: boolean; composing: boolean; dragging: boolean; findOpen: boolean; selectedCount: number; findInput?: boolean;
}

/** Shared priority for explicit dismissal; IME and text editing always get first refusal. */
export function paperKeyAction(event: PaperKey, state: PaperInteraction) {
  if (state.composing || event.isComposing || event.keyCode === 229 || event.repeat || event.altKey) return null;
  const key = event.key.toLowerCase();
  const command = event.ctrlKey || event.metaKey;
  if (key === "escape" || (command && key === "w")) {
    if (state.editable && !state.findInput) return "cancel-edit";
    if (state.dragging) return "cancel-drag";
    if (state.findOpen) return "close-find";
    if (state.selectedCount) return "clear-selection";
    return "fold";
  }
  if (command && key === "f") return "find";
  if (key === "f3") return event.shiftKey ? "find-previous" : "find-next";
  if (state.editable) return null;
  if (command && key === "z") return event.shiftKey ? "redo" : "undo";
  if (command && key === "y") return "redo";
  if (command && key === "a") return "select-all";
  if (command && key === "c" && state.selectedCount) return "copy";
  if ((key === "delete" || key === "backspace") && state.selectedCount) return "delete";
  return null;
}

/** Read clipboard text before the browser's single-line input sanitizes line breaks. */
export function pastedTaskTitles(text: string, before = "", after = ""): string[] | null {
  if (!/[\r\n]/.test(text)) return null;
  const titles = splitPastedLines(before + text + after).map(title => title.replace(/^\[[ xX]\]\s*/, "").trim()).filter(Boolean);
  return titles.length ? titles : null;
}

export function findPaperTasks(tasks: readonly PlanTask[], query: string): string[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const seen = new Set<string>();
  return tasks.filter(task => {
    if (seen.has(task.id)) return false;
    seen.add(task.id);
    return [task.title, task.note, task.link?.title, task.link?.path, ...(task.attachments?.map(item => item.name) ?? [])]
      .some(text => text?.toLocaleLowerCase().includes(needle));
  }).map(task => task.id);
}

/** DOM-only edge scroll velocity, capped to avoid jumping across small paper windows. */
export function paperDragScroll(pointerY: number, top: number, bottom: number): number {
  const zone = Math.min(36, (bottom - top) / 3);
  if (pointerY < top + zone) return -Math.min(10, Math.max(0, (top + zone - pointerY) / 3));
  if (pointerY > bottom - zone) return Math.min(10, Math.max(0, (pointerY - bottom + zone) / 3));
  return 0;
}
