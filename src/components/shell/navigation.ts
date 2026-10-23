import { Home, FolderKanban, CalendarCheck2, CalendarClock, Folders, Newspaper, BookOpen, Wrench, Sparkles, MessageSquare, KeyRound, Plug, Terminal, LayoutGrid, Library } from "lucide-react";

export interface NavItem {
  to: string;
  key: string;
  icon: typeof Home;
}

/** 组内小节：只影响分组内部的排版（多小节时插一行小标签），不折叠。 */
export interface NavSection {
  /** 小节标签的 i18n key */
  key: string;
  items: NavItem[];
}

/**
 * 侧栏的一个分区：标题 + 若干小节。
 *
 * 「AI」曾经是一级菜单，现在收进「资料」当第二节：一级只留两个分区（工作台 / 资料），
 * 一眼扫完；AI 那几项仍然是独立一节，标签还在，不会和「文件 / 知识 / 资讯」糊在一起。
 */
export interface NavGroup {
  /** 组标题的 i18n key */
  key: string;
  /** 一级项的图标：一级是正常导航项，不是一个光秃秃的分区标签 */
  icon: typeof Home;
  sections: NavSection[];
  /** 组内全部条目（顺序即展示顺序），派生自 sections，供开关与平表使用 */
  items: NavItem[];
}

function group(key: string, icon: typeof Home, sections: NavSection[]): NavGroup {
  return { key, icon, sections, items: sections.flatMap(section => section.items) };
}

/**
 * 侧栏的两个分区（顺序即展示顺序）：
 * 工作台 = 本机日常；资料 = 阅读与沉淀（AI 作为其中一节）。
 */
export const NAV_GROUPS: NavGroup[] = [
  group("nav.workbench", LayoutGrid, [
    {
      key: "nav.workbench",
      items: [
        { to: "/", key: "nav.home", icon: Home },
        { to: "/plans", key: "nav.plans", icon: CalendarCheck2 },
        { to: "/projects", key: "nav.projects", icon: FolderKanban },
        { to: "/tools", key: "nav.tools", icon: Wrench },
      ],
    },
  ]),
  group("nav.library", Library, [
    {
      key: "nav.library",
      items: [
        { to: "/files", key: "nav.files", icon: Folders },
        { to: "/knowledge", key: "nav.knowledge", icon: BookOpen },
        { to: "/feeds", key: "nav.feeds", icon: Newspaper },
      ],
    },
    {
      key: "nav.ai",
      items: [
        { to: "/agent", key: "nav.agent", icon: MessageSquare },
        { to: "/schedules", key: "nav.schedules", icon: CalendarClock },
        { to: "/toolbox/prompts", key: "nav.prompts", icon: KeyRound },
        { to: "/toolbox/skills", key: "nav.skills", icon: Sparkles },
        { to: "/toolbox/mcp", key: "nav.mcp", icon: Plug },
        { to: "/toolbox/harness", key: "nav.harness", icon: Terminal },
      ],
    },
  ]),
];

/** 侧栏与右键菜单共用的一张平表（顺序即展示顺序）。 */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/** 组内小节；只有一节时用组标题当标签，不额外加一行。 */
export function sectionsOf(group: NavGroup): NavSection[] {
  return group.sections.length > 1 ? group.sections : [{ key: group.key, items: group.items }];
}
