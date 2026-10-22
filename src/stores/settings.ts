import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";
import type { ThemeMode } from "@/lib/theme";
import type { Lang } from "@/lib/i18n";
import { setCompletionPolicyReader } from "@/features/plans/store";
import {
  isAgentPreset,
  isPermissionMode,
  isThinkingLevel,
  type AgentPreset,
  type PermissionMode,
  type ThinkingLevel,
} from "@/features/agent/composer-core";

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
  /** 主窗口是否置顶（默认关：窗口不该一直压住别的应用） */
  alwaysOnTop: boolean;
  /**
   * 桌面 Dock 总开关（默认关）。
   *
   * 与下面的 `dockOpen` 不是一回事：dockOpen 是「显示/隐藏」这个常驻部件，
   * dockEnabled 是「要不要有这么个东西」—— 关掉时 Rust 侧连窗口都不创建，
   * 全局快捷键与贴边热区也一并停用。默认关：用户没主动要，就别在桌面上
   * 多出一条横条。
   */
  dockEnabled: boolean;
  /** 桌面 Dock：贴边与开关（窗口本体常驻托盘之外，关闭=销毁窗口） */
  dockEdge: "left" | "right" | "top";  dockOpen: boolean;
  /** 收纳盒飞出面板的磁贴图标边长（Ctrl+滚轮调节，32–72） */
  dockTileSize: number;
  /** Dock 显隐全局快捷键（空 = 无）；按下在托盘外切换 Dock 显示 */
  dockShortcut: string;
  /** 检测到全屏应用时自动隐藏 Dock */
  dockAutoHide: boolean;
  /** 侧栏三个分区是否展开（折叠侧栏时全部强制摊开，与这些值无关） */
  workbenchGroupOpen: boolean;
  libraryGroupOpen: boolean;
  aiGroupOpen: boolean;
  /** 被关掉的功能 id 列表（= NAV_GROUPS 里的 item.to 或 group.key）。
   *  同一份状态同时控制主侧栏与设置页：关掉「资讯」，侧栏那一项和设置里对应分节都消失。 */
  navDisabled: string[];
  /**
   * 对话面板的权限档（写不写本机数据由它决定，所以放在全局设置里而不是会话里：
   * 用户改的是「我这个人的尺度」，不是「这个会话的尺度」）。
   */
  agentPermission: PermissionMode;
  /** 对话面板的智能体预设（构建 / 计划 / 追问）。 */
  agentPreset: AgentPreset;
  /** 思考等级：auto = 跟随服务商模型里配的 reasoningEffort。 */
  agentThinking: ThinkingLevel;
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
  setDockEnabled: (v: boolean) => void;
  setDockOpen: (v: boolean) => void;
  setAlwaysOnTop: (v: boolean) => void;
  setDockTileSize: (v: number) => void;
  setDockShortcut: (v: string) => void;
  setDockAutoHide: (v: boolean) => void;
  setWorkbenchGroupOpen: (v: boolean) => void;
  setLibraryGroupOpen: (v: boolean) => void;
  setAiGroupOpen: (v: boolean) => void;
  setNavEnabled: (id: string, on: boolean) => void;
  setAgentPermission: (v: PermissionMode) => void;
  setAgentPreset: (v: AgentPreset) => void;
  setAgentThinking: (v: ThinkingLevel) => void;
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
      dockEnabled: false,
      dockOpen: true,
      alwaysOnTop: false,
      dockTileSize: 28,
      dockShortcut: "",
      dockAutoHide: false,
      workbenchGroupOpen: true,
      libraryGroupOpen: true,
      aiGroupOpen: true,
      navDisabled: [],
      agentPermission: "ask",
      agentPreset: "build",
      agentThinking: "auto",
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
      setDockEnabled: (dockEnabled) => set({ dockEnabled }),
      setDockOpen: (dockOpen) => set({ dockOpen }),
      setAlwaysOnTop: (alwaysOnTop) => set({ alwaysOnTop }),
      setDockTileSize: (dockTileSize) => set({ dockTileSize: Math.min(72, Math.max(16, Math.round(dockTileSize))) }),
      setDockShortcut: (dockShortcut) => set({ dockShortcut }),
      setDockAutoHide: (dockAutoHide) => set({ dockAutoHide }),
      setWorkbenchGroupOpen: (workbenchGroupOpen) => set({ workbenchGroupOpen }),
      setLibraryGroupOpen: (libraryGroupOpen) => set({ libraryGroupOpen }),
      setAiGroupOpen: (aiGroupOpen) => set({ aiGroupOpen }),
      setNavEnabled: (id, on) => set((state) => ({
        navDisabled: on ? state.navDisabled.filter((x) => x !== id) : [...state.navDisabled, id],
      })),
      setAgentPermission: (agentPermission) => set({ agentPermission }),
      setAgentPreset: (agentPreset) => set({ agentPreset }),
      setAgentThinking: (agentThinking) => set({ agentThinking }),
    }),
    {
      name: "settings",
      storage: createJSONStorage(() => tauriJsonStorage),
      version: 8,
      /**
       * v1 → v2：新增 `plansView`（旧 settings.json 没这个键，pill 会全不亮）。
       * v2 → v3：新增 `autoSortDone` / `autoClearDone`。
       * v3 → v4：新增 `aiGroupOpen`（侧栏 AI 组的展开态）。
       * v4 → v5：侧栏改三个分区，新增 `workbenchGroupOpen` / `libraryGroupOpen`。
       * v5 → v6：对话面板新增权限档 / 智能体预设 / 思考等级。
       * v6 → v7：新增 `alwaysOnTop`（主窗口置顶）。老用户升级后一律**不**置顶：
       *           旧版本没有这个开关，谈不上「他手动开过」。
       * v7 → v8：新增 `dockEnabled`（桌面 Dock 总开关）。同理默认关 ——
       *           没有这个字段就等于从没开过，升级不该突然在桌面上多一条横条。
       *
       * 迁移只补缺失字段、不改其它值；视图键与新增的三个值顺手校验，手改坏
       * 的退回默认而不是让整个页面白屏。
       */
      migrate: (persisted, version) => {
        const s = persisted as Partial<SettingsState> | undefined;
        if (!s) return persisted as SettingsState;
        if (version < 3) {
          s.plansView = isPlansView(s.plansView) ? s.plansView : "outline";
          // 缺失时才填默认：已经显式设过的（哪怕是 false）不能被覆盖
          s.autoSortDone = s.autoSortDone ?? true;
          s.autoClearDone = s.autoClearDone ?? false;
        } else if (s.dockTileSize === 46 || s.dockTileSize === 36) {
          // 旧默认磁贴偏大：静默并入新默认 28（用户手动调过的值不动）
          s.dockTileSize = 28;
        }
        if (version < 4) s.aiGroupOpen = true;
        if (version < 5) {
          s.workbenchGroupOpen = s.workbenchGroupOpen ?? true;
          s.libraryGroupOpen = s.libraryGroupOpen ?? true;
        }
        if (version < 6) {
          s.agentPermission = isPermissionMode(s.agentPermission) ? s.agentPermission : "ask";
          s.agentPreset = isAgentPreset(s.agentPreset) ? s.agentPreset : "build";
          s.agentThinking = isThinkingLevel(s.agentThinking) ? s.agentThinking : "auto";
        }
        if (version < 7) s.alwaysOnTop = s.alwaysOnTop ?? false;
        if (version < 8) s.dockEnabled = s.dockEnabled ?? false;
        return s as SettingsState;
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
