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

/** 文件管理页的三种展示：图标网格 / 紧凑列表 / 收纳盒（按分类聚合）。 */
export type FilesViewMode = "icons" | "list" | "boxes";

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
  /** 文件管理上次停留的展示方式（持久化：从 Dock 跳回来不跳回默认网格） */
  filesViewMode: FilesViewMode;
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
  /**
   * Dock 的两种形态：贴边侧栏（rail）/ 屏顶胶囊（capsule）。
   * 胶囊不参与吸附 —— 它的几何走 dock-core 的 dockFloatBounds。
   */
  dockStyle: "rail" | "capsule";
  /** 胶囊被拖到的工作区左边（逻辑像素）；null = 水平居中 */
  dockFloatX: number | null;
  /** 悬浮胶囊吸附的屏幕边（只支持 上 / 左 / 右） */
  dockFloatEdge: "top" | "left" | "right";
  /** 贴左右缘时的纵向位置（null = 垂直居中） */
  dockFloatY: number | null;
  /** 展开方向：居中向两边 / 钉住左缘向右 */
  dockExpandAnchor: "center" | "left";
  /** 收起形态：胶囊 / 指示条（对齐 BrimDeck 的两种紧凑形态） */
  dockCompactStyle: "capsule" | "line";
  /** 配色预设：只换品牌色相，见 tokens.css 的 [data-accent] */
  accentPreset: "sky" | "ocean" | "graphite" | "warm";
  /** 卡片高度（逻辑像素）：底部把手可拖 */
  dockCardHeight: number;
  /** 岛所在显示器（Tauri 的 monitor.name）；null = 跟随鼠标 */
  dockMonitorId: string | null;
  /** 整窗鼠标穿透：点击直接穿到后面的窗口 */
  dockClickThrough: boolean;
  /** 天气坐标：城市名只用于显示，实际请求用经纬度 */
  weatherCity: string;
  weatherLat: number;
  weatherLon: number;
  /** 收纳盒飞出面板的磁贴图标边长（Ctrl+滚轮调节，32–72） */
  dockTileSize: number;
  /** Dock 显隐全局快捷键（空 = 无）；按下在托盘外切换 Dock 显示 */
  dockShortcut: string;
  /** 检测到全屏应用时自动隐藏 Dock */
  dockAutoHide: boolean;
  /** 图钉：固定 Dock，鼠标离开/靠近边缘都不自动隐藏 */
  dockPinned: boolean;
  /** 侧栏三个分区是否展开（折叠侧栏时全部强制摊开，与这些值无关） */
  workbenchGroupOpen: boolean;
  libraryGroupOpen: boolean;
  aiGroupOpen: boolean;
  /** 被关掉的功能 id 列表（= NAV_GROUPS 里的 item.to 或 group.key）。
   *  同一份状态同时控制主侧栏与设置页：关掉「资讯」，侧栏那一项和设置里对应分节都消失。 */
  navDisabled: string[];
  /** 项目页保存的筛选视图：一组「迭代 + 状态 + 搜索词」的命名快照 */
  projectViews: { id: string; name: string; iteration: string; status: string; search: string }[];
  /** 主页「资讯」卡片显示哪个渠道；null = 自动（订阅顺序里的第一个源） */
  homeFeedSource: string | null;
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
  setFilesViewMode: (v: FilesViewMode) => void;
  setAutoSortDone: (v: boolean) => void;
  setAutoClearDone: (v: boolean) => void;
  setDockEdge: (edge: "left" | "right" | "top") => void;
  setDockStyle: (style: "rail" | "capsule") => void;
  setDockFloatX: (x: number | null) => void;
  setDockFloatEdge: (edge: "top" | "left" | "right") => void;
  setDockFloatY: (y: number | null) => void;
  setDockExpandAnchor: (anchor: "center" | "left") => void;
  setDockCompactStyle: (style: "capsule" | "line") => void;
  setAccentPreset: (preset: "sky" | "ocean" | "graphite" | "warm") => void;
  setDockCardHeight: (height: number) => void;
  setDockMonitorId: (id: string | null) => void;
  setDockClickThrough: (on: boolean) => void;
  setWeatherPlace: (city: string, lat: number, lon: number) => void;
  setDockEnabled: (v: boolean) => void;
  setDockOpen: (v: boolean) => void;
  setAlwaysOnTop: (v: boolean) => void;
  setDockTileSize: (v: number) => void;
  setDockShortcut: (v: string) => void;
  setDockAutoHide: (v: boolean) => void;
  setDockPinned: (v: boolean) => void;
  setWorkbenchGroupOpen: (v: boolean) => void;
  setLibraryGroupOpen: (v: boolean) => void;
  setAiGroupOpen: (v: boolean) => void;
  setNavEnabled: (id: string, on: boolean) => void;
  setProjectViews: (views: { id: string; name: string; iteration: string; status: string; search: string }[]) => void;
  setHomeFeedSource: (id: string | null) => void;
  setAgentPermission: (v: PermissionMode) => void;
  setAgentPreset: (v: AgentPreset) => void;
  setAgentThinking: (v: ThinkingLevel) => void;
}

const PLANS_VIEWS: PlansView[] = ["outline", "timeline", "kanban", "calendar", "stats", "archive"];
const FILES_VIEW_MODES: FilesViewMode[] = ["icons", "list", "boxes"];

/** 防手改坏 settings.json：读到不认识的视图键就退回大纲 */
function isPlansView(v: unknown): v is PlansView {
  return typeof v === "string" && (PLANS_VIEWS as string[]).includes(v);
}

function isFilesViewMode(v: unknown): v is FilesViewMode {
  return typeof v === "string" && (FILES_VIEW_MODES as string[]).includes(v);
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
      filesViewMode: "icons",
      /*
       * 置底默认开（纯显示效果、随时可逆），自动清除默认关（真删数据）。
       * 这个不对称是有意的：默认值应该只在「用户不会因此丢失东西」时才生效。
       */
      autoSortDone: true,
      autoClearDone: false,
      dockEdge: "right",
      dockStyle: "rail",
      dockFloatX: null,
      dockFloatEdge: "top",
      dockFloatY: null,
      dockExpandAnchor: "center",
      dockCompactStyle: "capsule",
      accentPreset: "sky",
      dockCardHeight: 591,
      dockMonitorId: null,
      dockClickThrough: false,
      weatherCity: "上海",
      weatherLat: 31.23,
      weatherLon: 121.47,
      dockEnabled: false,
      dockOpen: true,
      alwaysOnTop: false,
      dockTileSize: 28,
      dockShortcut: "",
      dockAutoHide: false,
      dockPinned: false,
      workbenchGroupOpen: true,
      libraryGroupOpen: false,
      aiGroupOpen: false,
      navDisabled: [],
      projectViews: [],
      homeFeedSource: null,
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
      setFilesViewMode: (filesViewMode) => set({ filesViewMode }),
      setAutoSortDone: (autoSortDone) => set({ autoSortDone }),
      setAutoClearDone: (autoClearDone) => set({ autoClearDone }),
      setDockEdge: (dockEdge) => set({ dockEdge }),
      setDockStyle: (dockStyle) => set({ dockStyle }),
      setDockFloatX: (dockFloatX) => set({ dockFloatX }),
      setDockFloatEdge: (dockFloatEdge) => set({ dockFloatEdge }),
      setDockFloatY: (dockFloatY) => set({ dockFloatY }),
      setDockExpandAnchor: (dockExpandAnchor) => set({ dockExpandAnchor }),
      setDockCompactStyle: (dockCompactStyle) => set({ dockCompactStyle }),
      setAccentPreset: (accentPreset) => set({ accentPreset }),
      setDockCardHeight: (dockCardHeight) => set({ dockCardHeight }),
      setDockMonitorId: (dockMonitorId) => set({ dockMonitorId }),
      setDockClickThrough: (dockClickThrough) => set({ dockClickThrough }),
      setWeatherPlace: (city, lat, lon) => set({ weatherCity: city, weatherLat: lat, weatherLon: lon }),
      setDockEnabled: (dockEnabled) => set({ dockEnabled }),
      setDockOpen: (dockOpen) => set({ dockOpen }),
      setAlwaysOnTop: (alwaysOnTop) => set({ alwaysOnTop }),
      setDockTileSize: (dockTileSize) => set({ dockTileSize: Math.min(72, Math.max(16, Math.round(dockTileSize))) }),
      setDockShortcut: (dockShortcut) => set({ dockShortcut }),
      setDockAutoHide: (dockAutoHide) => set({ dockAutoHide }),
      setDockPinned: (dockPinned) => set({ dockPinned }),
      setWorkbenchGroupOpen: (workbenchGroupOpen) => set({ workbenchGroupOpen }),
      setLibraryGroupOpen: (libraryGroupOpen) => set({ libraryGroupOpen }),
      setAiGroupOpen: (aiGroupOpen) => set({ aiGroupOpen }),
      setNavEnabled: (id, on) => set((state) => ({
        navDisabled: on ? state.navDisabled.filter((x) => x !== id) : [...state.navDisabled, id],
      })),
      setProjectViews: (projectViews) => set({ projectViews }),
      setHomeFeedSource: (homeFeedSource) => set({ homeFeedSource }),
      setAgentPermission: (agentPermission) => set({ agentPermission }),
      setAgentPreset: (agentPreset) => set({ agentPreset }),
      setAgentThinking: (agentThinking) => set({ agentThinking }),
    }),
    {
      name: "settings",
      storage: createJSONStorage(() => tauriJsonStorage),
      version: 10,
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
       * v8 → v9：新增 `filesViewMode`（文件管理的三种展示）。老用户默认图标网格，
       *           与升级前一致；手改坏的键退回默认。
       * v9 → v10：新增 `dockPinned`（图钉）。默认不固定，避免升级后 Dock 突然常驻。
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
        if (version < 9) s.filesViewMode = isFilesViewMode(s.filesViewMode) ? s.filesViewMode : "icons";
        if (version < 10) s.dockPinned = s.dockPinned ?? false;
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
