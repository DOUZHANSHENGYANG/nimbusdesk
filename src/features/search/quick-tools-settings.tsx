import { emit } from "@tauri-apps/api/event";
import { readJson, writeJson, inTauri } from "@/lib/tauri";
import { setQuickToolsShortcut } from "./api";

/**
 * 快捷工具只有一个可配置项：那条全局快捷键。所以这里不摆 UI ——
 * 编辑器在「设置 › 快捷键」，这里只留**读**与**写**两个动作，连同它自己的
 * 存储记录（`quick-tools-settings`）一起管，避免调用方各自拼一遍落盘逻辑。
 *
 * 以前这里是一个完整的设置区块（录制框 + 保存 + 打开面板），
 * 因为快捷键现在统一到一处，区块拆成了「两个函数 + 一个按钮」。
 */
const KEY = "quick-tools-settings";
export const DEFAULT_QUICK_TOOLS_SHORTCUT = "Ctrl+Alt+T";

export async function loadQuickToolsShortcut(): Promise<string> {
  const value = await readJson<unknown>(KEY);
  const state = (value as { state?: { shortcut?: unknown } } | null)?.state;
  return typeof state?.shortcut === "string" ? state.shortcut.trim() : DEFAULT_QUICK_TOOLS_SHORTCUT;
}

/** 注册全局热键，再把记录写回存储；两步都成功才算保存。 */
export async function saveQuickToolsShortcut(shortcut: string): Promise<void> {
  const next = shortcut.trim();
  await setQuickToolsShortcut(next);
  await writeJson(KEY, { state: { shortcut: next }, version: 1 });
  if (inTauri) await emit("storage://changed", { key: KEY }).catch(() => undefined);
}
