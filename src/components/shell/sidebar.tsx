import { useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ChevronRight, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/stores/settings";
import { cn } from "@/lib/utils";
import { useToolboxCounts, type ToolboxCounts } from "@/features/agenthub/counts";
import { AI_NAV, NAV_TOP, type NavItem } from "./navigation";

/** 与源侧侧栏同款的弹簧：滑得干脆、不来回晃。 */
const PILL_SPRING = { type: "spring", stiffness: 420, damping: 34 } as const;

const COUNT_KEYS: Record<string, keyof ToolboxCounts> = {
  "/toolbox/prompts": "prompts",
  "/toolbox/mcp": "mcp",
  "/toolbox/skills": "skills",
  "/toolbox/harness": "harness",
};

/**
 * 左侧导航：三层 —— 顶层项 / 可折叠的 AI 组 / 底部折叠按钮。
 *
 * 活跃指示是一枚 `layoutId` 药丸（motion）：它在所有条目之间只有一份，
 * 换页时自动从旧位置滑到新位置，跨「组内 ↔ 组外」也成立。
 * 外层标了 `layoutRoot`：侧栏宽度是 CSS 过渡在变的，不把投影根定在这里的话，
 * 每次展开/收起都会把「容器在动」误读成药丸在动。
 */
export function Sidebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const setCollapsed = useSettings((s) => s.setSidebarCollapsed);
  const aiOpenSetting = useSettings((s) => s.aiGroupOpen);
  const setAiOpen = useSettings((s) => s.setAiGroupOpen);
  const counts = useToolboxCounts(location.pathname);
  const reduce = useReducedMotion();
  const listRef = useRef<HTMLDivElement>(null);

  // 折叠后没有文字也没有角标，组头就没有意义了：直接摊开成图标列
  const aiOpen = collapsed || aiOpenSetting;
  const aiActive = AI_NAV.some((item) => item.to === location.pathname);

  const item = ({ to, key, icon: Icon }: NavItem) => {
    const active = location.pathname === to;
    const count = COUNT_KEYS[to] ? counts[COUNT_KEYS[to]] : undefined;
    return (
      <button
        key={to}
        type="button"
        data-active={active}
        onClick={() => navigate(to)}
        title={t(key)}
        className={cn(
          "relative flex h-9 shrink-0 items-center gap-3 rounded-[10px] px-2.5 text-[13.5px] font-medium transition-colors duration-200",
          active ? "text-sidebar-accent-foreground" : "text-sidebar-foreground hover:text-sidebar-accent-foreground",
          collapsed && "justify-center px-0",
        )}
      >
        {active && <Pill />}
        <Icon
          className={cn("relative z-10 size-4 shrink-0 transition-colors duration-200", active ? "text-brand" : "opacity-70")}
          strokeWidth={active ? 2.2 : 1.8}
        />
        {!collapsed && <span className="relative z-10 truncate">{t(key)}</span>}
        {!collapsed && count !== undefined && (
          <span
            className={cn(
              "relative z-10 ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
              active ? "bg-brand/15 text-brand" : "bg-muted text-muted-foreground",
            )}
          >
            {count}
          </span>
        )}
      </button>
    );
  };

  return (
    <nav
      className={cn(
        "mat-glass group relative flex shrink-0 flex-col rounded-[var(--pr-radius-xl)] transition-[width] duration-300",
        collapsed ? "w-(--sidebar-w-collapsed)" : "w-(--sidebar-w)",
      )}
      style={{ transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)" }}
    >
      <motion.div ref={listRef} layoutRoot className="relative flex min-h-0 flex-col gap-1 overflow-y-auto px-2 pt-2">
        {NAV_TOP.map(item)}

        {/* AI 组头：跟条目同宽同高，药丸在组头与子项之间直接滑过去 */}
        <button
          type="button"
          data-active={aiActive && !aiOpen && !collapsed}
          onClick={() => (collapsed ? setCollapsed(false) : setAiOpen(!aiOpenSetting))}
          title={t("nav.ai")}
          aria-expanded={aiOpen}
          className={cn(
            "relative flex h-9 shrink-0 items-center gap-3 rounded-[10px] px-2.5 text-[13.5px] font-medium transition-colors duration-200",
            aiActive && !aiOpen && !collapsed ? "text-sidebar-accent-foreground" : "text-sidebar-foreground hover:text-sidebar-accent-foreground",
            collapsed && "justify-center px-0",
          )}
        >
          {aiActive && !aiOpen && !collapsed && <Pill />}
          <span className="relative z-10 grid size-4 shrink-0 place-items-center">
            <ChevronRight
              className={cn("size-4 transition-transform duration-300", !collapsed && aiOpenSetting && "rotate-90", aiActive ? "text-brand" : "opacity-70")}
              strokeWidth={aiActive ? 2.2 : 1.8}
            />
          </span>
          {!collapsed && <span className="relative z-10 truncate">{t("nav.ai")}</span>}
        </button>

        {/* 组内条目：折叠态直接摊开，展开态由高度过渡收放 */}
        <motion.div
          initial={false}
          animate={{ height: aiOpen ? "auto" : 0, opacity: aiOpen ? 1 : 0 }}
          transition={reduce ? { duration: 0 } : PILL_SPRING}
          className="flex flex-col gap-1 overflow-hidden"
        >
          <div className={cn("flex flex-col gap-1", !collapsed && "pl-3")}>{AI_NAV.map(item)}</div>
        </motion.div>
      </motion.div>

      <div className="flex-1" />

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

/** 活跃指示药丸。全侧栏只有一个 `layoutId`，所以它会在条目之间滑动。 */
function Pill() {
  return (
    <motion.span layoutId="nav-pill" transition={PILL_SPRING} aria-hidden className="absolute inset-0 rounded-[10px] bg-sidebar-accent" />
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
