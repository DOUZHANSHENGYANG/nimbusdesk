import { useEffect, useRef, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { i18n, changeLang } from "@/lib/i18n";
import { applyTheme, isThemeSwitching } from "@/lib/theme";
import { getDataDir, windowReady, inTauri } from "@/lib/tauri";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { onStorageSynced } from "@/lib/storage";
import { isPopupWindow } from "@/features/files/popup";
import { useSettings, useSettingsHydrated } from "@/stores/settings";
import { useFiles, useFences } from "@/stores/files";
import { paperGeometryFor, usePapers } from "@/stores/papers";
import { openTodoPaper } from "@/lib/tauri";
import { ModalProvider } from "@/components/shell/modal-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { useReminderLoop } from "@/features/plans/reminder";
import { FeedsRuntime } from "@/features/feeds/runtime";
import { DesktopRuntime } from "@/features/files/desktop-runtime";
import { EdgeRuntime } from "@/features/desktop/edge-runtime";
import { KnowledgeRuntime } from "@/features/knowledge/runtime";
import { SearchRuntime } from "@/features/search";

/**
 * 提醒调度包装：`useReminderLoop` 是 hook，不能直接当组件渲染。
 * 由 Providers 的主窗口门控挂载；栅格只复用外观和存储同步。
 */
function ReminderLoop() {
  useReminderLoop();
  return null;
}

/** 全局 Provider 组合 + 设置同步（主题/语言/数据目录/防白闪显示） */
export function Providers({ children }: { children: ReactNode }) {
  const main = !inTauri || getCurrentWebviewWindow().label === "main";
  return (
    <I18nextProvider i18n={i18n}>
      <ModalProvider>
        <TooltipProvider delayDuration={300}>
          <StorageSync />
          <SettingsSync />
          {main && <>
            <PaperRestore />
            <ReminderLoop />
            <KnowledgeRuntime />
            <SearchRuntime />
            <FeedsRuntime />
            <DesktopRuntime />
            <EdgeRuntime />
          </>}
          {children}
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </ModalProvider>
    </I18nextProvider>
  );
}

/**
 * 启动时恢复桌面待办纸片。
 *
 * 放在全局 Provider 而不是计划页：纸片是常驻桌面的部件，
 * 用户上次开着它、这次打开应用停在主页，纸片也应该回来 ——
 * 要求「先进一次计划页」才恢复，会让人以为纸片丢了。
 *
 * 必须等 persist **水合完成**再读，不能只等 setTimeout(0)：
 * 存储是异步的（走 Tauri IPC 读 JSON），宏任务早就跑完了、数据还没回来，
 * 结果读到空 papers、一个窗口都不恢复 —— 而且不报错，看起来就像功能没生效。
 * （这一点与本项目其它地方不同：settings 的启动逻辑刻意不依赖水合，
 *   因为那里只需要「默认值可用」；而这里必须拿到磁盘上的真实记录。）
 */
function PaperRestore() {
  useEffect(() => {
    const restore = () => {
      const { papers } = usePapers.getState();
      for (const [date, st] of Object.entries(papers)) {
        if (!st.open) continue;
        // 标题只在 Alt+Tab 里可见；用日期串而非空串，避免任务栏出现无名窗口
        /*
         * 先按**纸片几何**建窗，哪怕它是胶囊形态。
         *
         * 胶囊形态的窗口几何要等 CapsuleView 挂载后自己摆（它得先问显示器工作区），
         * 而建窗这一步是同步的、还没有窗口可问。这里给个纸片位置就够了 ——
         * 胶囊挂载期间根节点 opacity 为 0，用户看不到这个中间态，
         * 摆好之后才显示出来。反过来「等算好位置再建窗」会把启动恢复拖成异步链。
         */
        void openTodoPaper(date, date, paperGeometryFor(date)).catch(() => undefined);
      }
    };

    /*
     * 刻意**不用** useRef 一次性门控（SettingsSync 那种写法）。
     *
     * StrictMode 会 effect → cleanup → effect 跑两遍：门控在第一次就把标志置了，
     * 第二次直接 return，于是「取消订阅后不再重新订阅」，水合完成时回调早被摘掉，
     * 纸片永远不恢复 —— 而且不报错。
     * 这里改为「已水合就立刻执行，否则订阅并在 cleanup 里退订」，
     * 重复执行也安全：openTodoPaper 对已存在的窗口是聚焦而不是新建。
     */
    if (usePapers.persist.hasHydrated()) {
      restore();
      return;
    }
    return usePapers.persist.onFinishHydration(restore);
  }, []);
  return null;
}

/**
 * 跨窗口数据同步：栅栏/菜单浮窗都是独立 WebView，各有自己的 store 副本。
 * 任一窗口写盘后，其他窗口据此重读并回灌，保证改名/增删立即一致。
 */
function StorageSync() {
  useEffect(() => {
    return onStorageSynced((key, value) => {
      if (!value || typeof value !== "object") return;
      // zustand persist 的落盘结构是 { state, version }
      const data = (value as { state?: Record<string, unknown> }).state;
      if (!data) return;

      // 用 setState 合并而不是 persist.rehydrate()：
      // rehydrate 是整体替换，会覆盖本窗口尚未落盘的本地改动（写入有 250ms 防抖）。
      // 这里只回灌「数据字段」，不覆盖本窗口的 action 函数。
      if (key === "files") {
        const { categories, items } = data as {
          categories?: unknown;
          items?: unknown;
        };
        useFiles.setState({
          ...(Array.isArray(categories) ? { categories } : {}),
          ...(Array.isArray(items) ? { items } : {}),
        } as never);
      } else if (key === "fences") {
        const { fences } = data as { fences?: unknown };
        if (fences && typeof fences === "object") {
          useFences.setState({ fences } as never);
        }
      } else if (key === "settings") {
        // 只同步跨窗口有意义的外观字段，避免覆盖本窗口正在编辑的设置
        const { theme, lang, filesRoot } = data as {
          theme?: unknown;
          lang?: unknown;
          filesRoot?: unknown;
        };
        useSettings.setState({
          ...(typeof theme === "string" ? { theme } : {}),
          ...(typeof lang === "string" ? { lang } : {}),
          ...(filesRoot === null || typeof filesRoot === "string" ? { filesRoot } : {}),
        } as never);
      }
    });
  }, []);
  return null;
}

function SettingsSync() {
  const hydrated = useSettingsHydrated();
  const theme = useSettings((s) => s.theme);
  const lang = useSettings((s) => s.lang);
  const setDataDir = useSettings((s) => s.setDataDir);
  const bootstrapped = useRef(false);

  // 挂载即执行：不依赖 persist 水合（hasHydrated 非响应式，
  // 首次运行无持久化文件时不会触发重渲染 —— 门控在它上面会让窗口永远不显示）
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    applyTheme(useSettings.getState().theme);
    changeLang(useSettings.getState().lang);

    // 直接通知显示（勿用 rAF：窗口 visible:false 时 WebView2 不派发
    // requestAnimationFrame，等首帧再显示会死锁）。主题在上行已同步应用，无白闪。
    // 菜单浮窗例外：它由打开方在菜单渲染完成后定位并 show()，不能自己冒出来。
    if (!isPopupWindow() && (!inTauri || getCurrentWebviewWindow().label === "main")) {
      void windowReady().catch((e) => console.error("[bootstrap] ready:", e));
    }
  }, []);

  // Data-directory display must not persist defaults before async hydration:
  // that would create a stale base and conflict with existing SQLite settings.
  useEffect(() => {
    if (!hydrated) return;
    void getDataDir().then(setDataDir).catch((error) => console.error("[bootstrap] data dir:", error));
  }, [hydrated, setDataDir]);

  // 水合后（或用户切换时）应用最新设置。
  // 主题：切换动画进行中冻结 —— 真实切换由 toggleThemeRadial 在幕布盖满/收拢时机执行
  useEffect(() => {
    if (!isThemeSwitching()) applyTheme(theme);
    changeLang(lang);
  }, [theme, lang]);

  return null;
}
