import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";
import type { ThemeMode } from "@/lib/theme";
import type { Lang } from "@/lib/i18n";

/** 计划的视图键（与 `features/plans/page.tsx` 的 VIEW_KEYS 对应） */
export type PlansView = "outline" | "timeline" | "kanban" | "calendar" | "stats" | "archive";

interface SettingsState {
  theme: ThemeMode;
  lang: Lang;
  sidebarCollapsed: boolean;
  /** 最近一次已解析的数据目录（展示用，真值在 Rust 侧解析） */
  dataDir: string | null;
  /** 文件库全局根目录：分类未单独绑定时，用 <root>/<分类名> 作为其目录 */
  filesRoot: string | null;
  /** 计划管理上次停留的视图（持久化：刷新/切页回来不跳回大纲） */
  plansView: PlansView;
  setTheme: (theme: ThemeMode) => void;
  setLang: (lang: Lang) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setDataDir: (dir: string | null) => void;
  setFilesRoot: (dir: string | null) => void;
  setPlansView: (v: PlansView) => void;
}

const PLANS_VIEWS: PlansView[] = ["outline", "timeline", "kanban", "calendar", "stats", "archive"];

/** 防手改坏 settings.json：读到不认识的视图键就退回大纲 */
function isPlansView(v: unknown): v is PlansView {
  return typeof v === "string" && (PLANS_VIEWS as string[]).includes(v);
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "dark",
      lang: "zh",
      sidebarCollapsed: false,
      dataDir: null,
      filesRoot: null,
      plansView: "outline",
      setTheme: (theme) => set({ theme }),
      setLang: (lang) => set({ lang }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setDataDir: (dataDir) => set({ dataDir }),
      setFilesRoot: (filesRoot) => set({ filesRoot }),
      setPlansView: (plansView) => set({ plansView }),
    }),
    {
      name: "settings",
      storage: createJSONStorage(() => tauriJsonStorage),
      version: 2,
      /**
       * v1 → v2：新增 `plansView`。
       *
       * 只补缺失字段、不改其它值 —— 旧 settings.json 没有这个键，
       * 直接读会是 undefined，pill 一个都不高亮。
       * 顺便校验取值：手改坏的视图键退回大纲，而不是让整个页面白屏。
       */
      migrate: (persisted, version) => {
        const s = persisted as Partial<SettingsState> | undefined;
        if (!s || version >= 2) return persisted as SettingsState;
        return {
          ...s,
          plansView: isPlansView(s.plansView) ? s.plansView : "outline",
        } as SettingsState;
      },
    },
  ),
);

/** persist 是否已完成水合（异步 Tauri 读取） */
export function useSettingsHydrated() {
  return useSettings.persist.hasHydrated();
}
