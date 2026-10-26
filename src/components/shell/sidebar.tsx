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
import { NAV_GROUPS, sectionsOf, type NavItem } from "./navigation";

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
 * 左侧导航：三个一级分区（工作台 / AI / 资料），每区一个可折叠标题。
 * 一级标题用比二级项更大的字号与更重的字重，避免又退化成「像二级菜单」。
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
  const navDisabled = useSettings((s) => s.navDisabled);
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

  /**
   * 一级分区是**手风琴**：展开一个就收起其它。
   *
   * 收起侧栏（collapsed）时不再「各组各自摊成图标列」——
   * 那会一次列出所有子项图标，看着像一堵图标墙。现在的规则是：
   * - 一个都没展开 → 只剩三个一级图标（一眼看清有哪几摊事）；
   * - 展开了某一个 → 只显示它下面的子图标（其余一级图标让位，点它有得选）。
   * 所以折叠态下 `open` 也跟随真实状态，不再被 `collapsed` 强行打开。
   */
  const setGroupOpen = (key: string) => {
    setWorkbenchOpen(key === "nav.workbench" ? !workbenchOpen : false);
    setAiOpen(key === "nav.ai" ? !aiOpen : false);
    setLibraryOpen(key === "nav.library" ? !libraryOpen : false);
  };

  const groupState: Record<string, { open: boolean; toggle: () => void }> = {
    "nav.workbench": { open: workbenchOpen, toggle: () => setGroupOpen("nav.workbench") },
    "nav.ai": { open: aiOpen, toggle: () => setGroupOpen("nav.ai") },
    "nav.library": { open: libraryOpen, toggle: () => setGroupOpen("nav.library") },
  };

  // 手风琴要求「同时只开一个」：挂载时按当前路由对齐一次（老用户的持久化状态可能是三个都开）。
  // 之后不再自动改 —— 用户手动开哪个就留哪个。
  useEffect(() => {
    const current = NAV_GROUPS.find((group) => group.items.some((entry) => entry.to === location.pathname));
    if (!current) return;
    setWorkbenchOpen(current.key === "nav.workbench");
    setAiOpen(current.key === "nav.ai");
    setLibraryOpen(current.key === "nav.library");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          "relative flex h-[40px] shrink-0 items-center gap-3 rounded-[10px] px-2.5 text-[13.5px] font-medium transition-colors duration-200 hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)]",
          active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          collapsed && "justify-center px-0",
        )}
      >
        {active && <Pill />}
        <Icon
          className={cn("relative z-10 size-4 shrink-0 transition-colors duration-200", active ? "text-brand" : "opacity-70")}
          strokeWidth={active ? 2.1 : 1.6}
        />
        {!collapsed && <span className="relative z-10 truncate">{t(key)}</span>}
        {/* 角标位每行都在（无数字时留空），这样右缘是齐的 */}
        {!collapsed && (
          <span
            className={cn(
              "relative z-10 ml-auto min-w-4 text-right text-[10.5px] tabular-nums",
              count === undefined || count === 0 ? "opacity-0" : active ? "text-brand" : "text-muted-foreground",
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
      <motion.div ref={listRef} layoutRoot className="relative flex min-h-0 flex-col overflow-y-auto px-2 pt-3 pb-2">
        {NAV_GROUPS.map((group, index) => {
          const state = groupState[group.key];
          const open = state.open;
          // 功能开关：被关掉的条目直接不渲染；一组全关掉，整组连标题一起消失
          const items = group.items.filter((entry) => !navDisabled.includes(entry.to));
          if (!items.length) return null;
          const groupActive = items.some((entry) => entry.to === location.pathname);
          return (
            <div key={group.key} className={cn("flex flex-col gap-0.5", !collapsed && index > 0 && "mt-6")}>
              {/* 一级就是一条正常导航项（图标 + 标签 + 箭头），不是分区小标签：
                  按用户给的 Ant Pro 式参考，一级字号 ≥ 二级，二级选中时一级也变色。 */}
              <button
                type="button"
                onClick={state.toggle}
                title={t(group.key)}
                aria-expanded={state.open}
                className={cn(
                  "relative flex h-[40px] shrink-0 items-center gap-3 rounded-[10px] px-2.5 text-[14px] font-semibold transition-colors duration-200 hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)]",
                  groupActive ? "text-brand" : "text-foreground/85 hover:text-foreground",
                  collapsed && "justify-center px-0",
                )}
              >
                <group.icon className="size-4 shrink-0" strokeWidth={1.9} />
                {!collapsed && <span className="truncate">{t(group.key)}</span>}
                {!collapsed && (
                  <ChevronRight
                    className={cn("ml-auto size-3.5 shrink-0 opacity-45 transition-transform duration-300", state.open && "-rotate-90")}
                    strokeWidth={2.2}
                  />
                )}
              </button>
              <motion.div
                initial={false}
                animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
                transition={reduce ? { duration: 0 } : PILL_SPRING}
                className="flex flex-col gap-0.5 overflow-hidden"
              >
                <div className={cn("flex flex-col gap-0.5", !collapsed && "pl-4")}>
                  {sectionsOf(group).map((section) => {
                    const sectionItems = section.items.filter((entry) => !navDisabled.includes(entry.to));
                    if (!sectionItems.length) return null;
                    return (
                      <div key={section.key} className="flex flex-col gap-0.5">
                        {/* 多小节时给一行小标签；现在三个分区各自只有一节，不会重复组标题 */}
                        {group.sections.length > 1 && !collapsed && section.key !== group.key && (
                          <p className="px-2.5 pt-2 pb-0.5 text-[10.5px] font-medium text-muted-foreground/60">{t(section.key)}</p>
                        )}
                        {sectionItems.map(item)}
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            </div>
          );
        })}
      </motion.div>

      <div className="flex-1" />

      <div className="flex flex-col gap-1 px-2 pb-3">
        <div aria-hidden className="mx-1 h-px bg-sidebar-border" />
        {!collapsed && dataRoot ? (
          <button
            type="button"
            title={dataRoot}
            onClick={() => void ahubApi.revealPath(dataRoot)}
            className="flex h-[40px] items-center gap-3 rounded-[10px] px-2.5 text-[12px] text-muted-foreground transition-colors duration-200 hover:text-foreground"
          >
            <FolderOpen className="size-4 shrink-0" strokeWidth={1.6} />
            <span className="truncate" dir="ltr">
              {t("nav.dataDir")}
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
    <motion.span layoutId="nav-pill" transition={PILL_SPRING} aria-hidden className="absolute inset-0 rounded-[10px] bg-[color-mix(in_srgb,var(--brand)_12%,transparent)]" />
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
        "flex h-[40px] items-center gap-3 rounded-[10px] px-2.5 text-[13.5px] font-medium transition-colors duration-200",
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
