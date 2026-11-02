import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Check, Settings2, Search } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { useSettings } from "@/stores/settings";
import { inTauri } from "@/lib/tauri";
import { openSearchWindow } from "@/features/search";

/** 页面自己的右键菜单项：只在该路由下出现 */
export interface AppMenuItem {
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  onSelect: () => void;
}

const EMPTY: AppMenuItem[] = [];
const extraMenus = new Map<string, AppMenuItem[]>();
const watchers = new Set<() => void>();
const notify = () => watchers.forEach((watcher) => watcher());

/**
 * 在页面里注册右键菜单项，离开路由自动移除。
 * 回调通过 ref 取最新一份，避免依赖里塞一堆状态。
 */
export function useAppMenuItems(items: AppMenuItem[]) {
  const { pathname } = useLocation();
  const latest = useRef(items);
  latest.current = items;
  const signature = items.map((item) => item.id).join("|");

  useEffect(() => {
    const stable = items.map((item) => ({
      ...item,
      onSelect: () => latest.current.find((entry) => entry.id === item.id)?.onSelect(),
    }));
    extraMenus.set(pathname, stable);
    notify();
    return () => {
      extraMenus.delete(pathname);
      notify();
    };
    // 只在路由或菜单项清单变化时重挂；处理函数从 latest 取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, signature]);
}

function usePageMenuItems(pathname: string) {
  const [items, setItems] = useState(() => extraMenus.get(pathname) ?? EMPTY);
  useEffect(() => {
    const sync = () => setItems(extraMenus.get(pathname) ?? EMPTY);
    sync();
    watchers.add(sync);
    return () => { watchers.delete(sync); };
  }, [pathname]);
  return items;
}

export function AppContextMenu({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const developerMode = useSettings((s) => s.developerMode);
  const pageItems = usePageMenuItems(pathname);

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
        {pageItems.length > 0 && <ContextMenuSeparator />}
        {pageItems.map(({ id, label, icon: Icon, onSelect }) => (
          <ContextMenuItem key={id} className="min-h-8 gap-2.5 px-2 text-[13px]" onSelect={onSelect}>
            {Icon ? <Icon className="size-4 text-muted-foreground" /> : null}
            <span className="flex-1">{label}</span>
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
