import { KeyRound, Plug, Sparkles, Terminal, Waypoints } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/ahub/lib/utils";

const TABS = {
  plugins: [
    { to: "/toolbox/prompts", key: "nav.prompts", icon: KeyRound },
    { to: "/toolbox/skills", key: "nav.skills", icon: Sparkles },
    { to: "/toolbox/mcp", key: "nav.mcp", icon: Plug },
  ],
  runtime: [
    { to: "/toolbox/harness", key: "nav.harnessShort", icon: Terminal },
    { to: "/toolbox/sessions", key: "nav.sessions", icon: Waypoints },
  ],
} as const;

/**
 * 页签切换器：合并成一页的几套子页面共用一条横向切换。
 *
 * 走的是各自的路由而不是本地 state——搜索、通知、更新队列里那些深链
 * （`/toolbox/skills`）全都还生效，只是侧栏把它们合并成了一个入口。
 */
export function ToolboxTabs({ group = "plugins" }: { group?: "plugins" | "runtime" }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  return (
    <div role="tablist" className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-muted/60 p-1">
      {TABS[group].map((tab) => {
        const Icon = tab.icon;
        const on = pathname.startsWith(tab.to);
        return (
          <button
            key={tab.to}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => navigate(tab.to)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium outline-none transition-all duration-200 focus-visible:ring-2 focus-visible:ring-ring",
              on ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {t(tab.key)}
          </button>
        );
      })}
    </div>
  );
}
