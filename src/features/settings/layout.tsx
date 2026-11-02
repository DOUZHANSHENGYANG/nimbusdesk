import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, BookOpen, Bot, CalendarCheck, Info, Keyboard, LayoutGrid, Rss, Search, SlidersHorizontal, Wrench } from "lucide-react";

import { NavList, type NavListGroup } from "@/components/shell/nav-list";
import { useModal } from "@/components/shell/modal-host";
import { useProviderCopy } from "@/features/ai/provider-copy";
import { cn } from "@/lib/utils";

import { AiDirtyProvider, useAiDirty } from "./ai-dirty";

/**
 * 设置的外壳：左侧是与**首页同一套** `NavList`，右侧是 `<Outlet/>`。
 *
 * 分区刻意与首页分类同名同形（项目 / AI / 工具），这样从工作台进设置不会有
 * 「换了一套导航语言」的割裂感；`系统设置` 顶替首页的位置做直达项，`关于`
 * 平铺在最后一个分组之后 —— 它不属于任何一摊功能。
 */
export function SettingsLayout() {
  return (
    <AiDirtyProvider>
      <SettingsShell />
    </AiDirtyProvider>
  );
}

function SettingsShell() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { confirm } = useModal();
  const aiCopy = useProviderCopy();
  const { dirty, setDirty } = useAiDirty();
  // 设置里的分组很少，默认全开：这是「一览」而不是「省空间」的场合
  const [open, setOpen] = useState<Record<string, boolean>>({
    "set-projects": true,
    "set-ai": true,
    "set-tools": true,
  });

  /** AI 页有未保存改动时，切走前先问一声（换路由 = 丢掉那些改动） */
  const go = async (to: string) => {
    const leavingAi = location.pathname.startsWith("/settings/ai") && !to.startsWith("/settings/ai");
    if (leavingAi && dirty) {
      const allowed = await confirm({
        title: aiCopy.discardTitle,
        description: aiCopy.discardHint,
        confirmText: aiCopy.discard,
        cancelText: aiCopy.stay,
      });
      if (!allowed) return;
      setDirty(false);
    }
    navigate(to);
  };

  const groups: NavListGroup[] = [
    {
      key: "set-system",
      label: t("settings.nav.system"),
      icon: SlidersHorizontal,
      to: "/settings",
      entries: [],
    },
    {
      key: "set-projects",
      label: t("nav.workbench"),
      icon: LayoutGrid,
      defaultTo: "/settings/plans",
      entries: [{ to: "/settings/plans", label: t("settings.nav.plans"), icon: CalendarCheck }],
    },
    {
      key: "set-ai",
      label: t("nav.ai"),
      icon: Bot,
      defaultTo: "/settings/ai/models",
      entries: [
        { to: "/settings/ai/models", label: t("settings.nav.aiModels"), icon: Bot },
        { to: "/settings/ai/knowledge", label: t("settings.nav.knowledge"), icon: BookOpen },
      ],
    },
    {
      key: "set-tools",
      label: t("nav.library"),
      icon: Wrench,
      defaultTo: "/settings/tools/search",
      entries: [
        { to: "/settings/tools/search", label: t("settings.nav.search"), icon: Search },
        { to: "/settings/tools/feeds", label: t("settings.nav.feeds"), icon: Rss },
        { to: "/settings/tools/desktop", label: t("settings.nav.desktop"), icon: LayoutGrid },
      ],
    },
    {
      key: "set-shortcuts",
      label: t("settings.nav.shortcuts"),
      icon: Keyboard,
      to: "/settings/shortcuts",
      entries: [],
    },
    {
      key: "set-about",
      label: t("settings.nav.about"),
      icon: Info,
      to: "/settings/about",
      entries: [],
    },
  ];

  return (
    <div className="flex h-full min-h-0">
      <nav className="flex w-52 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        <NavList
          groups={groups}
          activeId={location.pathname}
          open={open}
          onToggle={(key) => setOpen((prev) => ({ ...prev, [key]: !prev[key] }))}
          onSelect={(to) => void go(to)}
          collapsed={false}
          expandLabel={(name) => t("nav.expandGroup", { name })}
          footer={
            <div className="flex flex-col gap-1 px-2 pb-3">
              <div aria-hidden className="mx-1 h-px bg-sidebar-border" />
              <button
                type="button"
                onClick={() => void go("/")}
                className={cn(
                  "flex h-[40px] items-center gap-3 rounded-[10px] px-2.5 text-[13.5px] font-medium transition-colors duration-200",
                  "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
              >
                <ArrowLeft className="size-4 shrink-0" strokeWidth={1.8} />
                <span className="truncate">{t("settings.nav.back")}</span>
              </button>
            </div>
          }
        />
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="p-6 pb-10">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
