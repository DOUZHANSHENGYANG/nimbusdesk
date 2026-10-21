import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";
import type { ThemeMode } from "@/lib/theme";
import type { Lang } from "@/lib/i18n";
import { setCompletionPolicyReader } from "@/features/plans/store";

/** 计划的视图键（与 `features/plans/page.tsx` 的 VIEW_KEYS 对应） */
export type PlansView = "outline" | "timeline" | "kanban" | "calendar" | "stats" | "archive";

interface SettingsState {
  theme: ThemeMode;
  lang: Lang;
  sidebarCollapsed: boolean;
  developerMode: boolean;
  /** 最近一次已解析的数据目录（展示用，真值在 Rust 侧解析） */
  dataDir: string | null;
  /** 文件库全局根目录：分类未单独绑定时，用 <root>/<分类名> 作为其目录 */
  filesRoot: string | null;
  fenceShortcut: string;
  /** 计划管理上次停留的视图（持久化：刷新/切页回来不跳回大纲） */
  plansView: PlansView;
  /** 勾选完成后自动把该项沉到底部（只影响显示，数据不删） */
  autoSortDone: boolean;
  /** 勾选完成后自动把该项从列表移除（真删，可撤销） */
  autoClearDone: boolean;
  /** 桌面 Dock：贴边与开关（窗口本体常驻托盘之外，关闭=销毁窗口） */
  dockEdge: "left" | "right" | "top";
  dockOpen: boolean;
  /** 收纳盒飞出面板的磁贴图标边长（Ctrl+滚轮调节，32–72） */
  dockTileSize: number;
  /** Dock 显隐全局快捷键（空 = 无）；按下在托盘外切换 Dock 显示 */
  dockShortcut: string;
  /** 检测到全屏应用时自动隐藏 Dock */
  dockAutoHide: boolean;
  setTheme: (theme: ThemeMode) => void;
  setLang: (lang: Lang) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setDeveloperMode: (v: boolean) => void;
  setDataDir: (dir: string | null) => void;
  setFilesRoot: (dir: string | null) => void;
  setFenceShortcut: (shortcut: string) => void;
  setPlansView: (v: PlansView) => void;
  setAutoSortDone: (v: boolean) => void;
  setAutoClearDone: (v: boolean) => void;
  setDockEdge: (edge: "left" | "right" | "top") => void;
  setDockOpen: (v: boolean) => void;
  setDockTileSize: (v: number) => void;
  setDockShortcut: (v: string) => void;
  setDockAutoHide: (v: boolean) => void;
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
      developerMode: false,
      dataDir: null,
      filesRoot: null,
      fenceShortcut: "",
      plansView: "outline",
      /*
       * 置底默认开（纯显示效果、随时可逆），自动清除默认关（真删数据）。
       * 这个不对称是有意的：默认值应该只在「用户不会因此丢失东西」时才生效。
       */
      autoSortDone: true,
      autoClearDone: false,
      dockEdge: "right",
      dockOpen: true,
      dockTileSize: 28,
      dockShortcut: "",
      dockAutoHide: false,
      setTheme: (theme) => set({ theme }),
      setLang: (lang) => set({ lang }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setDeveloperMode: (developerMode) => set({ developerMode }),
      setDataDir: (dataDir) => set({ dataDir }),
      setFilesRoot: (filesRoot) => set({ filesRoot }),
      setFenceShortcut: (fenceShortcut) => set({ fenceShortcut }),
      setPlansView: (plansView) => set({ plansView }),
      setAutoSortDone: (autoSortDone) => set({ autoSortDone }),
      setAutoClearDone: (autoClearDone) => set({ autoClearDone }),
      setDockEdge: (dockEdge) => set({ dockEdge }),
      setDockOpen: (dockOpen) => set({ dockOpen }),
      setDockTileSize: (dockTileSize) => set({ dockTileSize: Math.min(72, Math.max(16, Math.round(dockTileSize))) }),
      setDockShortcut: (dockShortcut) => set({ dockShortcut }),
      setDockAutoHide: (dockAutoHide) => set({ dockAutoHide }),
    }),
    {
      name: "settings",
      storage: createJSONStorage(() => tauriJsonStorage),
      version: 3,
      /**
       * v1 → v2：新增 `plansView`（旧 settings.json 没这个键，pill 会全不亮）。
       * v2 → v3：新增 `autoSortDone` / `autoClearDone`。
       *
       * 迁移只补缺失字段、不改其它值；视图键顺手校验，手改坏的退回大纲
       * 而不是让整个页面白屏。
       */
      migrate: (persisted, version) => {
        const s = persisted as Partial<SettingsState> | undefined;
        if (!s) return persisted as SettingsState;
        if (version >= 3) {
          // 旧默认磁贴偏大：静默并入新默认 28（用户手动调过的值不动）
          if (s.dockTileSize === 46 || s.dockTileSize === 36) s.dockTileSize = 28;
          return persisted as SettingsState;
        }
        return {
          ...s,
          plansView: isPlansView(s.plansView) ? s.plansView : "outline",
          // 缺失时才填默认：已经显式设过的（哪怕是 false）不能被覆盖
          autoSortDone: s.autoSortDone ?? true,
          autoClearDone: s.autoClearDone ?? false,
        } as SettingsState;
      },
    },
  ),
);

/*
 * 把「完成后自动处理」的读取器注入给 plans store。
 *
 * 为什么不直接在 plans store 里 import useSettings：
 * 那会让 settings ↔ plans 形成模块环（plans 也需要被 settings 引用以注入），
 * 循环 import 在 ESM 下会得到 undefined 的绑定，而且报错时机很晚、很难查。
 * 注入式让依赖方向只有一条：settings → plans。
 *
 * 放在模块顶层而不是 React 组件里：store 的动作（toggleDone）可能在任何
 * 时机被调用（包括纸片窗口），不能依赖某个组件已经挂载。
 */
setCompletionPolicyReader(() => {
  const s = useSettings.getState();
  return { autoClear: s.autoClearDone, autoSortDone: s.autoSortDone };
});

/** persist 是否已完成水合（异步 Tauri 读取） */
export function useSettingsHydrated() {
  return useSettings.persist.hasHydrated();
}
