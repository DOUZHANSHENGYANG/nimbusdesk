import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { i18n, changeLang } from "@/lib/i18n";
import { applyTheme, isThemeSwitching } from "@/lib/theme";
import { getDataDir, windowReady, setMainAlwaysOnTop, inTauri } from "@/lib/tauri";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { onStorageSynced } from "@/lib/storage";
import { isPopupWindow } from "@/features/files/popup";
import { useSettings, useSettingsHydrated } from "@/stores/settings";
import { useFiles, useFences } from "@/stores/files";
import { applyRemoteFilesDelta, type FilesPersisted } from "@/stores/files-storage";
import type { FilesDelta } from "@/lib/files-diff";
import { ModalProvider } from "@/components/shell/modal-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

/**
 * 主窗口专属的后台任务（项目/禅道/知识/搜索/资讯/桌面/目录映射/边缘坞/提醒/纸片恢复）
 * 走 `lazy`：它们只有主窗口用，但栅栏、待办纸片、右键菜单、Dock 这些独立小窗口
 * 也会挂 `Providers` —— 静态 import 会让每个小窗口都背上这一整套依赖。
 */
const MainRuntimes = lazy(() => import("./main-runtimes"));

/** 全局 Provider 组合 + 设置同步（主题/语言/数据目录/防白闪显示） */
export function Providers({ children }: { children: ReactNode }) {
  const main = !inTauri || getCurrentWebviewWindow().label === "main";
  return (
    <I18nextProvider i18n={i18n}>
      <ModalProvider>
        <TooltipProvider delayDuration={300}>
          <StorageSync />
          <SettingsSync />
          {main && (
            <Suspense fallback={null}>
              <MainRuntimes />
            </Suspense>
          )}
          {children}
          <Toaster position="top-right" offset={56} />
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
    return onStorageSynced((key, value) => {      if (!value || typeof value !== "object") return;
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
        // 只同步跨窗口有意义的字段，避免覆盖本窗口正在编辑的设置
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

  /*
   * `files` 走行级表之后，跨窗口同步不再是「整份文档变了重读」，而是**一份增量**：
   * 写成功的窗口广播 `files://changed`，这里把同一份增量合进本窗口的 store。
   * `applyRemoteFilesDelta` 内部会置 `applyingRemote`，让这次回灌引起的 `set()`
   * 只更新落库快照、不回写（否则两个窗口会来回弹）。
   */
  useEffect(() => {
    if (!inTauri) return;
    let stop: (() => void) | undefined;
    let alive = true;
    void listen<{ delta?: FilesDelta }>("files://changed", ({ payload }) => {
      if (!payload?.delta) return;
      void applyRemoteFilesDelta(payload.delta, {
        getState: () => useFiles.getState() as unknown as FilesPersisted,
        setState: (partial) => useFiles.setState(partial as never),
      });
    })
      .then((unlisten) => {
        if (alive) stop = unlisten;
        else unlisten();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      stop?.();
    };
  }, []);

  return null;
}

function SettingsSync() {
  const hydrated = useSettingsHydrated();
  const theme = useSettings((s) => s.theme);
  const lang = useSettings((s) => s.lang);
  const setDataDir = useSettings((s) => s.setDataDir);
  const bootstrapped = useRef(false);

  // 挂载即执行：不依赖 persist 水合（hasHydrated 非响应式），
  // 首次运行无持久化文件时不会触发重渲染 —— 门闩在它上面会让窗口永远不显示
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    applyTheme(useSettings.getState().theme);
    changeLang(useSettings.getState().lang);

    // 直接通知显示（别用 rAF：窗口 visible:false 时 WebView2 不派发
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

  /*
   * 主窗口置顶：挂载即应用一次（默认不置顶），之后跟着设置走。
   *
   * 用 subscribe 而不是把值放进依赖数组：persist 水合是异步的，挂载那一刻
   * 读到的还是默认 false；水合时 zustand 会把磁盘上的值 setState 进来，
   * 订阅者因此能补上「用户上次点了置顶」这件事，不必再等一次渲染。
   */
  useEffect(() => {
    if (!inTauri || getCurrentWebviewWindow().label !== "main") return;
    const apply = () => {
      void setMainAlwaysOnTop(useSettings.getState().alwaysOnTop)
        .catch((error) => console.error("[bootstrap] alwaysOnTop:", error));
    };
    apply();
    return useSettings.subscribe((state, previous) => {
      if (state.alwaysOnTop !== previous.alwaysOnTop) apply();
    });
  }, []);

  return null;
}
