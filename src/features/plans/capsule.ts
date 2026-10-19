import { childrenOf, type PlanTask } from "@/features/plans/types";

/** PaperTodo inspired the edge-preview interaction. Placement is implemented by desktop/edge-dock. */
export type CapsuleEdge = "left" | "right" | "top";
export type PaperForm = "paper" | "capsule";

/** Preserve the main task order and expose subtasks without recursing through corrupt identifiers. */
export function flattenTree(tasks: PlanTask[], parentId: string | null = null, depth = 0): { task: PlanTask; depth: number }[] {
  const out: { task: PlanTask; depth: number }[] = [];
  const visited = new Set<string>();
  const visit = (parent: string | null, level: number) => {
    for (const task of childrenOf(tasks, parent)) {
      if (visited.has(task.id)) continue;
      visited.add(task.id);
      out.push({ task, depth: level });
      visit(task.id, level + 1);
    }
  };
  visit(parentId, depth);
  return out;
}
