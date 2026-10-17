import { useEffect, type ReactNode } from "react";
import { Check, Settings2, Search } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuLabel } from "@/components/ui/context-menu";
import { useSettings } from "@/stores/settings";
import { inTauri } from "@/lib/tauri";
import { NAV_ITEMS } from "./navigation";
import { openSearchWindow } from "@/features/search";

export function AppContextMenu({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const developerMode = useSettings((s) => s.developerMode);

  useEffect(() => {
    const guardDebugShortcut = (event: KeyboardEvent) => {
      if (developerMode) return;
      if (event.key === "F12" || ((event.ctrlKey || event.metaKey) && event.shiftKey && ["KeyI", "KeyJ", "KeyC"].includes(event.code))) {
        event.preventDefault();
        // Tauri injects its own Ctrl+Shift+I handler on document. Intercept
        // before it can invoke the internal toggle command in normal mode.
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", guardDebugShortcut, true);
    return () => window.removeEventListener("keydown", guardDebugShortcut, true);
  }, [developerMode]);

  // Also disable native Inspect/F12 in normal mode, including editing menus.
  useEffect(() => {
    if (!inTauri) return;
    void invoke("set_developer_mode", { enabled: developerMode }).catch((error) => {
      toast.error(t("settings.developerModeError"), { description: String(error) });
      if (developerMode) useSettings.getState().setDeveloperMode(false);
    });
  }, [developerMode, t]);

  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        disabled={developerMode}
        onContextMenuCapture={(event) => {
          if (developerMode) {
            // Native Inspect should also work over feature-specific menus.
            event.stopPropagation();
            return;
          }
          if (!(event.target instanceof Element)) return;
          // Let the OS handle text editing and selected text; do not replace
          // copy/paste or open a global navigation menu over a modal draft.
          if (event.target.closest('input,textarea,[contenteditable]:not([contenteditable="false"])') || window.getSelection()?.toString()) {
            event.stopPropagation();
          } else if (event.target.closest('[role="dialog"],[role="alertdialog"]')) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <div className="h-full min-h-0 select-text">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52 p-1.5 [animation:none]" collisionPadding={8}>
        <ContextMenuItem className="min-h-8 gap-2.5 px-2 text-[13px]" onSelect={() => void openSearchWindow().catch(error => toast.error(String(error)))}><Search className="size-4 text-muted-foreground" />{i18n.language.startsWith("en") ? "Global search" : "全局搜索"}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuLabel className="px-2 pb-1.5 text-xs text-muted-foreground">{t("nav.quickJump")}</ContextMenuLabel>
        {NAV_ITEMS.map(({ to, key, icon: Icon }) => (
          <ContextMenuItem
            key={to}
            className="min-h-8 gap-2.5 px-2 text-[13px]"
            onSelect={() => { if (pathname !== to) navigate(to); }}
          >
            <Icon className="size-4 text-muted-foreground" />
            <span className="flex-1">{t(key)}</span>
            {pathname === to && <Check className="size-3.5 text-brand" />}
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem className="min-h-8 gap-2.5 px-2 text-[13px]" onSelect={() => { if (pathname !== "/settings") navigate("/settings"); }}>
          <Settings2 className="size-4 text-muted-foreground" />
          <span className="flex-1">{t("settings.title")}</span>
          {pathname === "/settings" && <Check className="size-3.5 text-brand" />}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
