import { Home, FolderKanban, CalendarCheck2, Folders, Newspaper, BookOpen, Wrench, Boxes, Sparkles } from "lucide-react";

/** Sidebar and context menu share the same destinations and labels. */
export const NAV_ITEMS = [
  { to: "/", key: "nav.home", icon: Home },
  { to: "/projects", key: "nav.projects", icon: FolderKanban },
  { to: "/plans", key: "nav.plans", icon: CalendarCheck2 },
  { to: "/files", key: "nav.files", icon: Folders },
  { to: "/feeds", key: "nav.feeds", icon: Newspaper },
  { to: "/knowledge", key: "nav.knowledge", icon: BookOpen },
  { to: "/agent", key: "nav.agent", icon: Sparkles },
  { to: "/tools", key: "nav.tools", icon: Wrench },
  { to: "/toolbox", key: "nav.toolbox", icon: Boxes },
] as const;
