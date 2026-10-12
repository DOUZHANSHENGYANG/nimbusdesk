import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

const ROUTE_TITLE: Record<string, string> = {
  "/": "nav.home",
  "/projects": "nav.projects",
  "/plans": "nav.plans",
  "/files": "nav.files",
  "/settings": "settings.title",
};

/** 顶栏：页面标题（语言/主题/设置已移至标题栏工具组） */
export function Topbar() {
  const { t } = useTranslation();
  const location = useLocation();

  const titleKey = ROUTE_TITLE[location.pathname] ?? "nav.home";

  return (
    <div className="flex h-12 shrink-0 items-center border-b border-border/60 bg-background px-6">
      <h1 className="text-[15px] font-semibold tracking-tight">{t(titleKey)}</h1>
    </div>
  );
}
