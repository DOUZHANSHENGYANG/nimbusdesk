import { useEffect, useRef, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { i18n, changeLang } from "@/lib/i18n";
import { applyTheme, isThemeSwitching } from "@/lib/theme";
import { getDataDir, windowReady } from "@/lib/tauri";
import { useSettings } from "@/stores/settings";
import { ModalProvider } from "@/components/shell/modal-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

/** 全局 Provider 组合 + 设置同步（主题/语言/数据目录/防白闪显示） */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <ModalProvider>
        <TooltipProvider delayDuration={300}>
          <SettingsSync />
          {children}
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </ModalProvider>
    </I18nextProvider>
  );
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
    void windowReady().catch((e) => console.error("[bootstrap] ready:", e));
  }, []);

  // 水合后（或用户切换时）应用最新设置。
  // 主题：切换动画进行中冻结 —— 真实切换由 toggleThemeRadial 在幕布盖满/收拢时机执行
  useEffect(() => {
    if (!isThemeSwitching()) applyTheme(theme);
    changeLang(lang);
  }, [theme, lang]);

  return null;
}
