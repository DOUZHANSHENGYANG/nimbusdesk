import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ChevronRight, FolderOpen, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/stores/settings";
import { cn } from "@/lib/utils";
import { inTauri } from "@/lib/tauri";
import { useData } from "@/ahub/stores/data";
import { useSettings as useAhubSettings } from "@/ahub/stores/settings";
import { api as ahubApi } from "@/ahub/lib/api";
import { NAV_GROUPS, type NavItem } from "./navigation";

/** 与源侧侧栏同款的弹簧：滑得干脆、不来回晃。 */
const PILL_SPRING = { type: "spring", stiffness: 420, damping: 34 } as const;

/** 角标只数「摆在那里的条目」：本机工具是一次机器扫描的结果，不在这里数（见 `useToolboxCounts`）。 */
const COUNT_KEYS: Record<string, "prompts" | "skills" | "mcp"> = {
  "/toolbox/prompts": "prompts",
  "/toolbox/skills": "skills",
  "/toolbox/mcp": "mcp",
};

/**
 * 侧栏角标的数字：读 ahub 自己的 store —— 与工具箱四个页面同一份数据，
 * 页面内增删会自己刷新，这里不需要重复数。
 *
 * 只在首帧补一次 `loadAll()`：用户可能只在主页开局，从没进过工具箱，
 * 那时 store 还是空的。它只发三条列表查询（提示词 / 技能 / MCP），
 * 不碰机器。
 *
 * shortcut: 本机工具那格不做数字 —— 唯一来源 `scan_harnesses` 要扫一遍机器，
 *           为一行小数字不值当（原 counts.ts 就记着这个代价）。要显示时改成
 *           扫描完成事件驱动的失效通知，而不是每次路由变化重扫。
 */
function useToolboxCounts(): Partial<Record<"prompts" | "skills" | "mcp", number>> {
  const prompts = useData((s) => s.prompts.length);
  const skills = useData((s) => s.skills.length);
  const mcp = useData((s) => s.mcp.length);
  useEffect(() => {
    // 浏览器预览没有 Tauri：invoke 会 reject，角标留空即可
    if (!inTauri) return;
    void useData.getState().loadAll();
  }, []);
  return { prompts, skills, mcp };
}

/**
 * 左侧导航：三个分区（工作台 / 资料 / AI），每区一个可折叠标题。
 *
 * 活跃指示有两层：一枚 `layoutId` 药丸（motion）在所有**条目**之间只有一份，
 * 换页时自动滑过去；活跃行左缘另有一条品牌色竖条，颜色比药丸更醒目。
 * 组标题不是条目，药丸永远不会落在它上面。
 *
 * 外层标了 `layoutRoot`：侧栏宽度是 CSS 过渡在变的，不把投影根定在这里的话，
 * 每次展开/收起都会把「容器在动」误读成药丸在动。
 */
export function Sidebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const setCollapsed = useSettings((s) => s.setSidebarCollapsed);
  const workbenchOpen = useSettings((s) => s.workbenchGroupOpen);
  const libraryOpen = useSettings((s) => s.libraryGroupOpen);
  const aiOpen = useSettings((s) => s.aiGroupOpen);
  const setWorkbenchOpen = useSettings((s) => s.setWorkbenchGroupOpen);
  const setLibraryOpen = useSettings((s) => s.setLibraryGroupOpen);
  const setAiOpen = useSettings((s) => s.setAiGroupOpen);
  const counts = useToolboxCounts();
  const dataRoot = useAhubSettings((s) => s.info?.dataDirs.root);
  useEffect(() => {
    // 数据目录入口需要 ahub 的 settings.info，而宿主只在工具箱页挂载；
    // 用户可能停在主页——这里补一次（只读，三个列表查询都不发）。
    if (!inTauri) return;
    if (!useAhubSettings.getState().info) void useAhubSettings.getState().refresh();
  }, []);
  const reduce = useReducedMotion();
  const listRef = useRef<HTMLDivElement>(null);

  // 折叠态没有文字也没有角标，组头就没有意义了：三组各自摊成图标列
  const groupState: Record<string, { open: boolean; toggle: () => void }> = {
    "nav.workbench": { open: workbenchOpen, toggle: () => setWorkbenchOpen(!workbenchOpen) },
    "nav.library": { open: libraryOpen, toggle: () => setLibraryOpen(!libraryOpen) },
    "nav.ai": { open: aiOpen, toggle: () => setAiOpen(!aiOpen) },
  };

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
          "relative flex h-[28px] shrink-0 items-center gap-3 rounded-[10px] px-2.5 text-[13.5px] font-medium transition-colors duration-200 hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)]",
          active ? "text-foreground" : "text-sidebar-foreground hover:text-foreground",
          collapsed && "justify-center px-0",
        )}
      >
        {active && <Pill />}
        {active && (
          <span aria-hidden className="absolute inset-y-0 left-0 z-10 w-[2.5px] rounded-r-[3px] bg-brand" />
        )}
        <Icon
          className={cn("relative z-10 size-4 shrink-0 transition-colors duration-200", active ? "text-brand" : "opacity-70")}
          strokeWidth={active ? 2.2 : 1.8}
        />
        {!collapsed && <span className="relative z-10 truncate">{t(key)}</span>}
        {/* 角标位每行都在（无数字时留空），这样右缘是齐的 */}
        {!collapsed && (
          <span
            className={cn(
              "relative z-10 ml-auto min-w-4 text-right text-[10.5px] tabular-nums",
              count === undefined ? "opacity-0" : active ? "text-brand" : "text-muted-foreground",
            )}
          >
            {count ?? 0}
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
      <motion.div ref={listRef} layoutRoot className="relative flex min-h-0 flex-col gap-1 overflow-y-auto px-2 pt-1.5 pb-1">
        {NAV_GROUPS.map((group, index) => {
          const state = groupState[group.key];
          const open = collapsed || state.open;
          return (
            <div key={group.key} className={cn("flex flex-col gap-0.5", !collapsed && index > 0 && "mt-1")}>
              {/* 折叠态：不显示组标题，组与组之间用一条发丝线分隔 */}
              {collapsed
                ? index > 0 && <div aria-hidden className="mx-1.5 my-1 h-px bg-sidebar-border" />
                : (
                  <button
                    type="button"
                    onClick={state.toggle}
                    title={t(group.key)}
                    aria-expanded={state.open}
                    className="flex h-[18px] shrink-0 items-center gap-3 rounded-[10px] px-2.5 text-[11px] font-medium text-muted-foreground transition-colors duration-200 hover:text-sidebar-accent-foreground"
                  >
                    <group.icon aria-hidden className="size-3.5 shrink-0 opacity-60" strokeWidth={2} />
                    <span className="truncate">{t(group.key)}</span>
                    <span aria-hidden className="h-px flex-1 bg-sidebar-border" />
                    <ChevronRight
                      className={cn("size-[11px] shrink-0 opacity-50 transition-transform duration-300", state.open && "rotate-90")}
                      strokeWidth={2.2}
                    />
                  </button>
                )}
              <motion.div
                initial={false}
                animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
                transition={reduce ? { duration: 0 } : PILL_SPRING}
                className="flex flex-col gap-0.5 overflow-hidden"
              >
                {group.items.map(item)}
              </motion.div>
            </div>
          );
        })}
      </motion.div>

      <div className="flex-1" />

      <div className="flex flex-col gap-1 px-2 pb-1.5">
        <div aria-hidden className="mx-1 h-px bg-sidebar-border" />
        {!collapsed && dataRoot ? (
          <button
            type="button"
            title={t("nav.dataDir")}
            onClick={() => void ahubApi.revealPath(dataRoot)}
            className="flex h-[28px] items-center gap-3 rounded-[10px] px-2.5 text-[12px] text-sidebar-foreground/75 transition-colors duration-200 hover:text-foreground"
          >
            <FolderOpen className="size-4 shrink-0" strokeWidth={1.8} />
            <span className="truncate" dir="ltr">
              {dataRoot}
            </span>
          </button>
        ) : null}
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
    <motion.span layoutId="nav-pill" transition={PILL_SPRING} aria-hidden className="absolute inset-0 rounded-[10px] bg-[color-mix(in_srgb,var(--foreground)_7%,transparent)]" />
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
        "flex h-[28px] items-center gap-3 rounded-[10px] px-2.5 text-[13.5px] font-medium transition-colors duration-200",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon className="size-4 shrink-0" strokeWidth={1.8} />
      {!collapsed && <span className="truncate">{label}</span>}
    </button>
  );
}
