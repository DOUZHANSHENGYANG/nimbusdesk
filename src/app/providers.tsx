import { useEffect, useRef, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { i18n, changeLang } from "@/lib/i18n";
import { applyTheme, isThemeSwitching } from "@/lib/theme";
import { getDataDir, windowReady } from "@/lib/tauri";
import { onStorageSynced } from "@/lib/storage";
import { isPopupWindow } from "@/features/files/popup";
import { useSettings } from "@/stores/settings";
import { useFiles, useFences } from "@/stores/files";
import { ModalProvider } from "@/components/shell/modal-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

/** 全局 Provider 组合 + 设置同步（主题/语言/数据目录/防白闪显示） */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <ModalProvider>
        <TooltipProvider delayDuration={300}>
          <StorageSync />
          <SettingsSync />
          {children}
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </ModalProvider>
    </I18nextProvider>
  );
}

/**
 * 跨窗口数据同步：栅栏/菜单浮窗都是独立 WebView，各有自己的 store 副本。
 * 任一窗口写盘后，其他窗口据此重读并回灌，保证改名/增删立即一致。
 */
function StorageSync() {
  useEffect(() => {
    return onStorageSynced((key, value) => {
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

    void getDataDir()
      .then(setDataDir)
      .catch((e) => console.error("[bootstrap] data dir:", e));

    // 直接通知显示（勿用 rAF：窗口 visible:false 时 WebView2 不派发
    // requestAnimationFrame，等首帧再显示会死锁）。主题在上行已同步应用，无白闪。
    // 菜单浮窗例外：它由打开方在菜单渲染完成后定位并 show()，不能自己冒出来。
    if (!isPopupWindow()) {
      void windowReady().catch((e) => console.error("[bootstrap] ready:", e));
    }
  }, []);

  // 水合后（或用户切换时）应用最新设置。
  // 主题：切换动画进行中冻结 —— 真实切换由 toggleThemeRadial 在幕布盖满/收拢时机执行
  useEffect(() => {
    if (!isThemeSwitching()) applyTheme(theme);
    changeLang(lang);
  }, [theme, lang]);

  return null;
}
