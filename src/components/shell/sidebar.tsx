import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { gsap, useGSAP, DUR, EASE } from "@/lib/gsap";
import { useSettings } from "@/stores/settings";
import { cn } from "@/lib/utils";
import { NAV_ITEMS } from "./navigation";

/** 左侧导航：活跃胶囊指示器（GSAP 滑动） */
export function Sidebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const setCollapsed = useSettings((s) => s.setSidebarCollapsed);

  const listRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);

  // 活跃项指示器滑动
  useGSAP(
    () => {
      const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
      const pill = pillRef.current;
      if (!active || !pill) return;
      gsap.to(pill, {
        y: active.offsetTop,
        height: active.offsetHeight,
        duration: DUR.base,
        ease: EASE.out,
      });
    },
    { dependencies: [location.pathname, collapsed], scope: listRef },
  );

  // 初次定位（无动画）
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    const pill = pillRef.current;
    if (active && pill) gsap.set(pill, { y: active.offsetTop, height: active.offsetHeight });
  }, []);

  return (
    <nav
      className={cn(
        "mat-glass group relative flex shrink-0 flex-col rounded-[var(--pr-radius-xl)] transition-[width] duration-300",
        collapsed ? "w-(--sidebar-w-collapsed)" : "w-(--sidebar-w)",
      )}
      style={{ transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)" }}
    >
      <div ref={listRef} className="relative flex flex-col gap-1 px-2 pt-2">
        {/* 活跃胶囊 */}
        <div
          ref={pillRef}
          aria-hidden
          className="pointer-events-none absolute left-2 right-2 top-0 rounded-[10px] bg-sidebar-accent opacity-0"
        />
        {NAV_ITEMS.map(({ to, key, icon: Icon }) => {
          const active = location.pathname === to;
          return (
            <button
              key={to}
              type="button"
              data-active={active}
              onClick={() => navigate(to)}
              title={t(key)}
              className={cn(
                "relative z-10 flex h-9 items-center gap-3 rounded-[10px] px-2.5 text-[13.5px] font-medium transition-colors duration-200",
                active
                  ? "text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:text-sidebar-accent-foreground",
                collapsed && "justify-center px-0",
              )}
            >
              <Icon
                className={cn(
                  "size-4 shrink-0 transition-colors duration-200",
                  active ? "text-brand" : "opacity-70",
                )}
                strokeWidth={active ? 2.2 : 1.8}
              />
              {!collapsed && <span className="truncate">{t(key)}</span>}
            </button>
          );
        })}
      </div>

      <div className="flex-1" />

      {/* 底部：折叠 */}
      <div className="flex flex-col gap-1 px-2 pb-2">
        <SidebarBottomButton
          icon={collapsed ? PanelLeftOpen : PanelLeftClose}
          label={collapsed ? t("nav.expand") : t("nav.collapse")}
          collapsed={collapsed}
          onClick={() => setCollapsed(!collapsed)}
        />
      </div>
    </nav>
  );
}

function SidebarBottomButton({
  icon: Icon,
  label,
  collapsed,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  collapsed: boolean;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-9 items-center gap-3 rounded-lg px-3 text-[13px] font-medium transition-colors duration-200",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon className="size-4.5 shrink-0" strokeWidth={1.8} />
      {!collapsed && <span className="truncate">{label}</span>}
    </button>
  );
}
