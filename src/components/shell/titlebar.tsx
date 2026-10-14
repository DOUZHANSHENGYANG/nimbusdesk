import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Minus, Square, Copy, X, Cloud, Sun, Moon, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { inTauri } from "@/lib/tauri";
import { toggleThemeRadial } from "@/lib/theme";
import { changeLang } from "@/lib/i18n";
import { useSettings } from "@/stores/settings";
import { cn } from "@/lib/utils";

const appWindow = inTauri ? getCurrentWebviewWindow() : null;

/** 自绘标题栏：品牌区 + 右侧工具组（语言/主题/设置）+ 窗口控制 */
export function Titlebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [isMax, setIsMax] = useState(false);
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const lang = useSettings((s) => s.lang);
  const setLang = useSettings((s) => s.setLang);

  useEffect(() => {
    if (!appWindow) return;
    let disposed = false;
    void appWindow.isMaximized().then((v) => !disposed && setIsMax(v));
    const unlisten = appWindow.onResized(async () => {
      setIsMax(await appWindow.isMaximized());
    });
    return () => {
      disposed = true;
      void unlisten.then((fn) => fn());
    };
  }, []);

  // 品牌/窗口标题跟随语言：中文「云台」/ 英文「NimbusDesk」，同时同步任务栏标题
  useEffect(() => {
    const name = t("app.name");
    void appWindow?.setTitle(name).catch(() => undefined);
  }, [t]);

  const toggleMax = () => void appWindow?.toggleMaximize();

  const onThemeClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    void toggleThemeRadial(next, e.clientX, e.clientY);
  };

  const onLangClick = () => {
    const next = lang === "zh" ? "en" : "zh";
    setLang(next);
    changeLang(next);
  };

  return (
    <header
      data-tauri-drag-region
      onDoubleClick={toggleMax}
      className="relative z-50 flex h-(--titlebar-h) shrink-0 items-stretch justify-between border-b border-sidebar-border bg-sidebar select-none"
    >
      {/* 左：品牌区（可拖拽） */}
      <div data-tauri-drag-region className="flex items-center gap-2.5 pl-3.5 pr-2">
        <span className="grid size-6 place-items-center rounded-md bg-brand/15 text-brand">
          <Cloud className="size-4" strokeWidth={2.2} />
        </span>
        <span
          data-tauri-drag-region
          className="text-[13px] font-semibold tracking-wide text-sidebar-foreground"
        >
          {t("app.name")}
        </span>
      </div>

      {/* 中：空拖拽区 */}
      <div data-tauri-drag-region className="flex-1" />

      {/* 右：工具组（语言/主题/设置）+ 窗口控制 */}
      <div className="flex items-stretch">
        <div className="flex items-center gap-0.5 pr-1.5">
          <ToolbarButton title={t("topbar.language")} onClick={onLangClick}>
            <span className="text-[11px] font-bold tracking-wide">
              {lang === "zh" ? "中" : "EN"}
            </span>
          </ToolbarButton>
          <ToolbarButton
            title={theme === "dark" ? t("topbar.themeToLight") : t("topbar.themeToDark")}
            onClick={onThemeClick}
          >
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </ToolbarButton>
          <ToolbarButton
            title={t("nav.settings")}
            active={location.pathname === "/settings"}
            onClick={() => {
              if (location.pathname === "/settings") navigate(-1);
              else navigate("/settings");
            }}
          >
            <Settings2 className="size-4" />
          </ToolbarButton>
        </div>

        <div className="flex items-stretch border-l border-sidebar-border/60">
          <TitlebarButton label={t("titlebar.minimize")} onClick={() => void appWindow?.minimize()}>
            <Minus className="size-4" />
          </TitlebarButton>
          <TitlebarButton
            label={isMax ? t("titlebar.restore") : t("titlebar.maximize")}
            onClick={toggleMax}
          >
            {isMax ? <Copy className="size-3.5" /> : <Square className="size-3" />}
          </TitlebarButton>
          <TitlebarButton label={t("titlebar.close")} danger onClick={() => void appWindow?.close()}>
            <X className="size-4" />
          </TitlebarButton>
        </div>
      </div>
    </header>
  );
}

/** 标题栏工具按钮（语言/主题/设置） */
function ToolbarButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "grid size-8 place-items-center rounded-lg transition-colors duration-150",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:opacity-70",
      )}
    >
      {children}
    </button>
  );
}

function TitlebarButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex w-12 items-center justify-center text-sidebar-foreground/80 transition-colors duration-150",
        danger
          ? "hover:bg-red-500 hover:text-white active:bg-red-600"
          : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:opacity-70",
      )}
    >
      {children}
    </button>
  );
}
