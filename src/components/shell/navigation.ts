import { Home, FolderKanban, CalendarCheck2, CalendarClock, Folders, Newspaper, BookOpen, Wrench, Sparkles, MessageSquare, KeyRound, Plug, Terminal, LayoutGrid, Library, Bot } from "lucide-react";

export interface NavItem {
  to: string;
  key: string;
  icon: typeof Home;
}

/** 侧栏的一个分区：标题 + 条目（组标题自身不是条目，不可导航）。 */
export interface NavGroup {
  /** 组标题的 i18n key */
  key: string;
  /** 组标题的小图标：给标题一个视觉锚点，不再是悬空的字 */
  icon: typeof Home;
  items: NavItem[];
}

/**
 * 侧栏的三个分区（顺序即展示顺序）：
 * 工作台 = 本机日常，资料 = 阅读/沉淀，AI = 对话与工具箱。
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    key: "nav.workbench",
    icon: LayoutGrid,
    items: [
      { to: "/", key: "nav.home", icon: Home },
      { to: "/plans", key: "nav.plans", icon: CalendarCheck2 },
      { to: "/projects", key: "nav.projects", icon: FolderKanban },
      { to: "/tools", key: "nav.tools", icon: Wrench },
    ],
  },
  {
    key: "nav.library",
    icon: Library,
    items: [
      { to: "/files", key: "nav.files", icon: Folders },
      { to: "/knowledge", key: "nav.knowledge", icon: BookOpen },
      { to: "/feeds", key: "nav.feeds", icon: Newspaper },
    ],
  },
  {
    key: "nav.ai",
    icon: Bot,
    items: [
      { to: "/agent", key: "nav.agent", icon: MessageSquare },
      { to: "/schedules", key: "nav.schedules", icon: CalendarClock },
      { to: "/toolbox/prompts", key: "nav.prompts", icon: KeyRound },
      { to: "/toolbox/skills", key: "nav.skills", icon: Sparkles },
      { to: "/toolbox/mcp", key: "nav.mcp", icon: Plug },
      { to: "/toolbox/harness", key: "nav.harness", icon: Terminal },
    ],
  },
];

/** 侧栏与右键菜单共用的一张平表（顺序即展示顺序）。 */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);
