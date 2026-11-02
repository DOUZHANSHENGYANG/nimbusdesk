import { Home, CalendarCheck2, CalendarClock, Folders, FolderGit2, Newspaper, BookOpen, Wrench, Sparkles, Terminal, LayoutGrid, Library, Telescope } from "lucide-react";

export interface NavItem {
  to: string;
  key: string;
  icon: typeof Home;
  /** 命中的额外路径（子路由合并成一个入口时用）；空则按 to 精确匹配 */
  match?: string[];
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
 * `to` 非空 = **直达型一级项**：标题自己就是一条导航（点它跳转，不展开、没有箭头）。
 * 「首页」这种只有一个去处的一级项没必要先展开再点一次。
 */
export interface NavGroup {
  /** 组标题的 i18n key */
  key: string;
  /** 一级项的图标：一级是正常导航项，不是一个光秃秃的分区标签 */
  icon: typeof Home;
  sections: NavSection[];
  /** 组内全部条目（顺序即展示顺序），派生自 sections，供开关与平表使用 */
  items: NavItem[];
  /** 有值即直达：标题点击跳这里，不渲染子项 */
  to?: string;
  /** 有值即「点标题去这里，箭头才展开」——子项仍然保留 */
  defaultTo?: string;
}

function group(
  key: string,
  icon: typeof Home,
  sections: NavSection[],
  opts: { to?: string; defaultTo?: string } = {},
): NavGroup {
  return { key, icon, sections, items: sections.flatMap(section => section.items), ...opts };
}

/**
 * 侧栏的四个分区（顺序即展示顺序）：
 * 首页（直达） / 项目 / AI / 工具。
 *
 * 2026-10-31 第二轮调整：首页升为一级分类且点击直达；「工作台」更名「项目」
 * （本机工具已挪走）；「本机工具」更名「程序工具箱」并挪进「工具」分区。
 */
export const NAV_GROUPS: NavGroup[] = [
  group("nav.home", Home, [
    { key: "nav.home", items: [{ to: "/", key: "nav.home", icon: Home }] },
  ], { to: "/" }),
  group("nav.workbench", LayoutGrid, [
    {
      key: "nav.workbench",
      // 「项目管理」不再是二级项：项目标题本身就直达 /projects
      items: [{ to: "/plans", key: "nav.plans", icon: CalendarCheck2 }, { to: "/github", key: "nav.github", icon: FolderGit2 }],
    },
  ], { defaultTo: "/projects" }),
  group("nav.ai", Sparkles, [
    {
      key: "nav.ai",
      items: [
        // 「对话」不再是二级项：AI 标题本身就直达 /ai/agent
        { to: "/ai/schedules", key: "nav.schedules", icon: CalendarClock },
        { to: "/ai/knowledge", key: "nav.knowledge", icon: BookOpen },
        // 技能 / 提示词 / MCP 合成一个入口，进去是三个页签；
        // match 让这三个子路由都算它「当前所在」。
        { to: "/toolbox/prompts", key: "nav.plugins", icon: Sparkles, match: ["/toolbox/prompts", "/toolbox/skills", "/toolbox/mcp"] },
        // 本机工具与会话也是同一类东西（"这台机器上跑着什么"），合成一个入口两个页签
        { to: "/toolbox/harness", key: "nav.runtime", icon: Terminal, match: ["/toolbox/harness", "/toolbox/sessions"] },
      ],
    },
  ], { defaultTo: "/ai/agent" }),
  group("nav.library", Library, [
    {
      key: "nav.library",
      items: [
        { to: "/tools", key: "nav.tools", icon: Wrench },
        { to: "/tools/files", key: "nav.files", icon: Folders },
        { to: "/tools/feeds", key: "nav.feeds", icon: Newspaper },
        { to: "/tools/research", key: "nav.research", icon: Telescope },
      ],
    },
  ], { defaultTo: "/tools" }),
];

/**
 * 侧栏与右键菜单共用的一张平表（顺序即展示顺序）。
 */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/** 组内小节；只有一节时用组标题当标签，不额外加一行。 */
export function sectionsOf(group: NavGroup): NavSection[] {
  return group.sections.length > 1 ? group.sections : [{ key: group.key, items: group.items }];
}
