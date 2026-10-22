import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Minus, Square, Copy, X, Sun, Moon, Settings2, Search, Pin, PinOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { inTauri, setMainAlwaysOnTop } from "@/lib/tauri";
import { toggleThemeRadial } from "@/lib/theme";
import { changeLang } from "@/lib/i18n";
import { useSettings } from "@/stores/settings";
import { cn } from "@/lib/utils";
import { openSearchWindow } from "@/features/search";
import { toast } from "sonner";

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
  const alwaysOnTop = useSettings((s) => s.alwaysOnTop);
  const setAlwaysOnTop = useSettings((s) => s.setAlwaysOnTop);

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

  /*
   * 置顶开关。
   *
   * 默认**不**置顶：窗口压住别人的应用是很强的主张，交给用户显式点。
   * 先写设置（持久层，重启后仍然生效）再调 Rust（只改当前层级）；
   * 命令失败就把设置回滚，否则按钮会显示一个没生效的状态。
   */
  const onPinClick = () => {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    void setMainAlwaysOnTop(next).catch((error) => {
      setAlwaysOnTop(!next);
      toast.error(String(error));
    });
  };

  return (
    <header
      data-tauri-drag-region
      onDoubleClick={toggleMax}
      className={cn(
        "relative z-50 flex h-(--titlebar-h) shrink-0 items-stretch justify-between titlebar-glass select-none",
      )}
    >
      {/* 左：品牌区（可拖拽） */}
      <div data-tauri-drag-region className="flex items-center gap-2.5 pl-3.5 pr-2">
        <img src="/app-icon.png" alt="" className="size-7 shrink-0" draggable={false} />
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
          <ToolbarButton title={lang === "en" ? "Global search" : "全局搜索"} onClick={() => void openSearchWindow().catch(error => toast.error(String(error)))}><Search className="size-4" /></ToolbarButton>
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
          {/* 置顶开关：图标反映状态（Pin = 已置顶，PinOff = 未置顶），aria-pressed 同步 */}
          <ToolbarButton
            title={alwaysOnTop ? t("titlebar.unpin") : t("titlebar.pin")}
            active={alwaysOnTop}
            pressed={alwaysOnTop}
            onClick={onPinClick}
          >
            {alwaysOnTop ? <Pin className="size-4" /> : <PinOff className="size-4" />}
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

/** 标题栏工具按钮（语言/主题/置顶/设置） */
function ToolbarButton({
  title,
  active,
  pressed,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  /** 有「开/关」语义的按钮用它反映状态；纯动作按钮（语言/设置）不传 */
  pressed?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={pressed}
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
          ? "hover:bg-[var(--close-hover-bg)] hover:text-[var(--close-hover-fg)]"
          : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:opacity-70",
      )}
    >
      {children}
    </button>
  );
}
