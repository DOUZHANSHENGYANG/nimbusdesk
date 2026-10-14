import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";
import type { ThemeMode } from "@/lib/theme";
import type { Lang } from "@/lib/i18n";

interface SettingsState {
  theme: ThemeMode;
  lang: Lang;
  sidebarCollapsed: boolean;
  /** 最近一次已解析的数据目录（展示用，真值在 Rust 侧解析） */
  dataDir: string | null;
  /** 文件库全局根目录：分类未单独绑定时，用 <root>/<分类名> 作为其目录 */
  filesRoot: string | null;
  setTheme: (theme: ThemeMode) => void;
  setLang: (lang: Lang) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setDataDir: (dir: string | null) => void;
  setFilesRoot: (dir: string | null) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "dark",
      lang: "zh",
      sidebarCollapsed: false,
      dataDir: null,
      filesRoot: null,
      setTheme: (theme) => set({ theme }),
      setLang: (lang) => set({ lang }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setDataDir: (dataDir) => set({ dataDir }),
      setFilesRoot: (filesRoot) => set({ filesRoot }),
    }),
    {
      name: "settings",
      storage: createJSONStorage(() => tauriJsonStorage),
      version: 1,
    },
  ),
);

/** persist 是否已完成水合（异步 Tauri 读取） */
export function useSettingsHydrated() {
  return useSettings.persist.hasHydrated();
}
