import { getCurrentWindow } from "@tauri-apps/api/window";
import { Languages, Minus, Settings, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ThemeToggle } from "@/ahub/components/ThemeToggle";
import { useUi } from "@/ahub/stores/ui";
import { useSettings } from "@/ahub/stores/settings";
import { cn } from "@/ahub/lib/utils";

function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="6" fill="var(--ah-primary)" />
      <path
        d="M8 15.5V8.5L12 12.2L16 8.5V15.5"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TitleBar() {
  const { t } = useTranslation();
  const language = useSettings((s) => s.language);
  const setLanguage = useSettings((s) => s.setLanguage);
  const win = getCurrentWindow();
  const setPage = useUi((s) => s.setPage);

  return (
    <header
      data-tauri-drag-region
      className="ah-material-strong flex h-11 shrink-0 select-none items-center border-b border-border pl-3.5"
    >
      <div data-tauri-drag-region className="flex items-center gap-2">
        <Logo />
        <span data-tauri-drag-region className="text-[13px] font-semibold tracking-wide text-foreground">
          {t("app.name")}
        </span>
      </div>

      <div data-tauri-drag-region className="h-full flex-1" />

      <div className="flex items-center gap-0.5 pr-0">
        <button
          type="button"
          title="中文 / English"
          onClick={() => void setLanguage(language === "zh" ? "en" : "zh")}
          className="flex h-8 items-center gap-1 rounded-lg px-2 text-ink-2 outline-none transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Languages className="size-4" />
          <span className="text-[11px] font-medium uppercase">{language === "zh" ? "中" : "EN"}</span>
        </button>
        <ThemeToggle />
        {/* 设置入口：位于明暗切换图标右侧 → 切换到应用内独立设置界面 */}
        <button
          type="button"
          title={t("nav.settings")}
          aria-label={t("nav.settings")}
          onClick={() => setPage("settings")}
          className="mr-1 grid size-8 place-items-center rounded-lg text-ink-2 outline-none transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Settings className="size-4" />
        </button>
        <WindowButton onClick={() => void win.minimize()} label="Minimize">
          <Minus className="size-4" />
        </WindowButton>
        <WindowButton onClick={() => void win.toggleMaximize()} label="Maximize">
          <Square className="size-3" />
        </WindowButton>
        <WindowButton danger onClick={() => void win.close()} label="Close">
          <X className="size-4" />
        </WindowButton>
      </div>
    </header>
  );
}

function WindowButton({
  children,
  onClick,
  danger,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "grid h-11 w-11 place-items-center text-ink-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        danger ? "hover:bg-danger hover:text-white" : "hover:bg-surface-2 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
