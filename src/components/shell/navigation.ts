import { Home, FolderKanban, CalendarCheck2, Folders, Newspaper, BookOpen, Wrench, Sparkles, MessageSquare, KeyRound, Plug, Terminal } from "lucide-react";

export interface NavItem {
  to: string;
  key: string;
  icon: typeof Home;
}

/** AI 组：对话 + 工具箱的四个页面（原版 AgentHub 就是四个独立页）。 */
export const AI_NAV: NavItem[] = [
  { to: "/agent", key: "nav.agent", icon: MessageSquare },
  { to: "/toolbox/prompts", key: "nav.prompts", icon: KeyRound },
  { to: "/toolbox/mcp", key: "nav.mcp", icon: Plug },
  { to: "/toolbox/skills", key: "nav.skills", icon: Sparkles },
  { to: "/toolbox/harness", key: "nav.harness", icon: Terminal },
];

/** AI 组之外的顶层目的地。 */
export const NAV_TOP: NavItem[] = [
  { to: "/", key: "nav.home", icon: Home },
  { to: "/projects", key: "nav.projects", icon: FolderKanban },
  { to: "/plans", key: "nav.plans", icon: CalendarCheck2 },
  { to: "/files", key: "nav.files", icon: Folders },
  { to: "/feeds", key: "nav.feeds", icon: Newspaper },
  { to: "/knowledge", key: "nav.knowledge", icon: BookOpen },
  { to: "/tools", key: "nav.tools", icon: Wrench },
];

/** 侧栏与右键菜单共用的一张平表（顺序即展示顺序）。 */
export const NAV_ITEMS: NavItem[] = [...NAV_TOP, ...AI_NAV];
