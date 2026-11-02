/**
 * 执行撤销：把历史栈里最上面那一步真的倒回去。
 *
 * 只处理 `isUndoable` 认可的三种：rename / move / create。
 * 删除不会走到这里 —— 它在回收站里，UI 上说明清楚即可。
 */
import { deleteEntry, moveFenceEntries, renameEntry } from "@/lib/tauri";
import { useFiles } from "@/stores/files";
import { isUndoable, useFileHistory, type HistoryOp } from "./history";

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? "";
const parentDir = (path: string) => {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index > 0 ? path.slice(0, index) : "";
};
const join = (dir: string, name: string) => {
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${name}`;
};

/** 撤销一步；返回被撤销操作的说明，没有可撤销的就返回 null */
export async function undoLastFileOp(): Promise<HistoryOp | null> {
  const history = useFileHistory.getState();
  const op = history.stack.find(isUndoable);
  if (!op) return null;

  const files = useFiles.getState();

  if (op.kind === "rebox") {
    // 只换了归属、没动磁盘：撤销就是把分类改回去
    if (!op.to || !op.itemId) return null;
    files.updateItem(op.itemId, { categoryId: op.from });
    history.drop(op.id);
    return op;
  }

  if (op.kind === "rename") {
    if (!op.to) return null;
    const restored = await renameEntry(op.to, baseName(op.from));
    const item = files.items.find((entry) => entry.path === op.to);
    if (item) files.updateItem(item.id, { path: restored, title: baseName(restored) });
  } else if (op.kind === "move") {
    if (!op.to) return null;
    const dir = parentDir(op.from);
    if (!dir) return null;
    const result = await moveFenceEntries([op.to], dir);
    const moved = result.moved[0];
    const item = files.items.find((entry) => entry.path === op.to);
    if (moved && item) files.updateItem(item.id, { path: moved.path, title: moved.name });
  } else {
    // create：删掉当初建的那个空文件/空目录
    await deleteEntry(op.from);
    const item = files.items.find((entry) => entry.path === op.from);
    if (item) files.removeItem(item.id);
  }

  history.drop(op.id);
  return op;
}

/** 给 UI 用：栈顶那一步是啥（没有则 null） */
export function peekUndoLabel(): string | null {
  const op = useFileHistory.getState().stack.find(isUndoable);
  return op?.label ?? null;
}

export { join as joinPathForTest };
