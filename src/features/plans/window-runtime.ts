import { useEffect } from "react";
import { i18n } from "@/lib/i18n";
import { applyTheme } from "@/lib/theme";
import { onStorageSynced } from "@/lib/storage";
import { useSettings } from "@/stores/settings";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { flushAllStorage } from "@/lib/storage";
import { usePapers } from "@/stores/papers";
import { useStorageHealth } from "@/stores/storage-health";
import { inTauri } from "@/lib/tauri";

let closing = false;
export async function closeDailyTodo(date: string) {
  if (closing) return;
  closing = true;
  usePapers.getState().setOpen(date, false);
  try {
    await flushAllStorage();
    if (inTauri) await getCurrentWebviewWindow().destroy();
  } catch (error) {
    usePapers.getState().setOpen(date, true);
    useStorageHealth.getState().report("write", "todo-papers", String(error));
  } finally { closing = false; }
}

/** Daily paper has its own React root, outside the main app Providers. */
export function useTaskWindowSettings() {
  const theme = useSettings((state) => state.theme);
  const lang = useSettings((state) => state.lang);
  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => { void i18n.changeLanguage(lang); }, [lang]);
  useEffect(() => onStorageSynced((key, value) => {
    if (key !== "settings" || !value || typeof value !== "object") return;
    const state = (value as { state?: Record<string, unknown> }).state;
    if (!state) return;
    useSettings.setState({
      ...(state.theme === "light" || state.theme === "dark" ? { theme: state.theme } : {}),
      ...(state.lang === "zh" || state.lang === "en" ? { lang: state.lang } : {}),
      ...(typeof state.autoClearDone === "boolean" ? { autoClearDone: state.autoClearDone } : {}),
      ...(typeof state.autoSortDone === "boolean" ? { autoSortDone: state.autoSortDone } : {}),
    });
  }), []);
}
