import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { FolderOpen, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/stores/settings";
import { cn } from "@/lib/utils";
import { inTauri } from "@/lib/tauri";
import { useData } from "@/ahub/stores/data";
import { useSettings as useAhubSettings } from "@/ahub/stores/settings";
import { api as ahubApi } from "@/ahub/lib/api";
import { NAV_GROUPS } from "./navigation";
import { NavList, type NavListGroup } from "./nav-list";

/**
 * 角标只数「摆在那里的条目」：本机工具是一次机器扫描的结果，不在这里数（见 `useToolboxCounts`）。
 */
const COUNT_KEYS: Record<string, "toolbox"> = {
  // 三个子页合成一个入口后，角标给的是三者之和 —— 只显示技能数会误导
  "/toolbox/skills": "toolbox",
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
function useToolboxCounts(): Partial<Record<"toolbox", number>> {
  const prompts = useData((s) => s.prompts.length);
  const skills = useData((s) => s.skills.length);
  const mcp = useData((s) => s.mcp.length);
  useEffect(() => {
    // 浏览器预览没有 Tauri：invoke 会 reject，角标留空即可
    if (!inTauri) return;
    void useData.getState().loadAll();
  }, []);
  return { toolbox: prompts + skills + mcp };
}

/**
 * 首页左侧导航：只负责**数据与交互**（读 store、组装分组、接管跳转），
 * 呈现交给 `NavList` —— 设置侧栏用的是同一个组件，两处不可能漂移。
 *
 * 一级分区是手风琴（展开一个就收起其它）；组标题即导航项，箭头单独负责展开。
 * `NavList` 内部把投影根标在列表上，所以侧栏宽度过渡时药丸不会跟着乱动。
 */
export function Sidebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const setCollapsed = useSettings((s) => s.setSidebarCollapsed);
  const visualStyle = useSettings((s) => s.visualStyle);
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

  /**
   * 手风琴：展开一个就收起其它。
   *
   * 收起侧栏（collapsed）时不再「各组各自摊成图标列」——那会一次列出所有子项图标，
   * 看着像一堵图标墙。折叠态下 `open` 也跟随真实状态，不被 `collapsed` 强行打开。
   */
  const setGroupOpen = (key: string) => {
    setWorkbenchOpen(key === "nav.workbench" ? !workbenchOpen : false);
    setAiOpen(key === "nav.ai" ? !aiOpen : false);
    setLibraryOpen(key === "nav.library" ? !libraryOpen : false);
  };

  // 挂载时按当前路由对齐一次展开态（老用户的持久化状态可能是三个都开）；之后不再自动改。
  useEffect(() => {
    const hit = (entry: { to: string; match?: string[] }) =>
      entry.match ? entry.match.some((path) => location.pathname.startsWith(path)) : entry.to === location.pathname;
    const current = NAV_GROUPS.find(
      (group) => group.items.some(hit) || group.defaultTo === location.pathname,
    );
    if (!current) return;
    setWorkbenchOpen(current.key === "nav.workbench");
    setAiOpen(current.key === "nav.ai");
    setLibraryOpen(current.key === "nav.library");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openGroups: Record<string, boolean> = {
    "nav.workbench": workbenchOpen,
    "nav.ai": aiOpen,
    "nav.library": libraryOpen,
  };

  /*
   * 分组直接取 `group.items`：它已经是各 section 拍平后的结果，而当前每个分区只有一节，
   * 原来那段「多小节时插一行小标签」的分支从来没触发过。哪天真的需要多小节，再让 NavList 长出来。
   */
  const groups: NavListGroup[] = NAV_GROUPS.map((group) => ({
    key: group.key,
    label: t(group.key),
    icon: group.icon,
    ...(group.to !== undefined ? { to: group.to } : {}),
    ...(group.defaultTo !== undefined ? { defaultTo: group.defaultTo } : {}),
    entries: group.items
      .filter((entry) => !navDisabled.includes(entry.to))
      .map((entry) => {
        const badgeKey = COUNT_KEYS[entry.to];
        return {
          to: entry.to,
          label: t(entry.key),
          icon: entry.icon,
          match: entry.match,
          badge: badgeKey ? counts[badgeKey] : undefined,
        };
      }),
  })).filter((group) => group.entries.length > 0 || group.to !== undefined);

  return (
    <nav
      className={cn(
        "app-sidebar mat-glass group relative flex shrink-0 flex-col rounded-[var(--pr-radius-xl)] transition-[width] duration-300",
        collapsed ? "w-(--sidebar-w-collapsed)" : "w-(--sidebar-w)",
      )}
      style={{ transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)" }}
    >
      <NavList
        groups={groups}
        activeId={location.pathname}
        open={openGroups}
        onToggle={setGroupOpen}
        onSelect={(to) => navigate(to)}
        collapsed={collapsed}
        skin={visualStyle}
        expandLabel={(name) => t("nav.expandGroup", { name })}
        footer={
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
        }
      />
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
