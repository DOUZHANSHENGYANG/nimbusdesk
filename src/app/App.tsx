import { HashRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { inTauri } from "@/lib/tauri";
import { Providers } from "@/app/providers";
import { Titlebar } from "@/components/shell/titlebar";
import { StorageAlert } from "@/components/shell/storage-alert";
import { Sidebar } from "@/components/shell/sidebar";
import { PageTransition } from "@/components/shell/page-transition";
import { HomePage } from "@/features/home/page";
import { ProjectsPage } from "@/features/projects/page";
import { PlansPage } from "@/features/plans/page";
import { FilesPage } from "@/features/files/page";
import { FeedsPage } from "@/features/feeds/page";
import { SettingsPage } from "@/features/settings/page";
import { KnowledgePage } from "@/features/knowledge/page";
import { OrganizationActivity } from "@/features/knowledge/organization-activity";
import { ToolsPage } from "@/features/tools/page";
import { AppContextMenu } from "@/components/shell/app-context-menu";

function SearchNavigationBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!inTauri) return;
    let active = true;
    const subscription = listen<string>("search://navigate", ({ payload }) => {
      if (active && /^\/(plans|knowledge|feeds|files|projects)(\?|$)/.test(payload)) navigate(payload);
    });
    return () => { active = false; void subscription.then(stop => stop()).catch(() => undefined); };
  }, [navigate]);
  return null;
}

/** 布局路由：/settings 为完全独立整页（无侧栏/顶栏），其余走后台布局 */
function Shell() {
  const location = useLocation();
  const standalone = location.pathname === "/settings";

  return (
    <AppContextMenu>
    <div className="flex h-full flex-col overflow-hidden">
      <Titlebar />
      {/* 落盘失败告警：挂在标题栏下方、所有布局之上 —— 它是应用级状态，
          设置页（standalone）也必须能看到 */}
      <StorageAlert />
      <OrganizationActivity />
      <div className="flex min-h-0 flex-1">
        {!standalone && <Sidebar />}
        <div className="flex min-w-0 flex-1 flex-col">
          {/*
            这里原本有一条 h-12 的顶栏，只用来显示「当前页名」——
            而左侧侧边栏已经把同一个名字高亮显示了，每一页都是重复的两份。
            去掉它，内容区直接靠到标题栏下方，等于给所有页面多出 48px 呼吸空间。
          */}
          <main className="min-h-0 flex-1 overflow-hidden">
            <PageTransition>
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/plans" element={<PlansPage />} />
                <Route path="/files" element={<FilesPage />} />
                <Route path="/feeds" element={<FeedsPage />} />
                <Route path="/knowledge" element={<KnowledgePage />} />
                <Route path="/tools" element={<ToolsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </PageTransition>
          </main>
        </div>
      </div>
    </div>
    </AppContextMenu>
  );
}

export default function App() {
  return (
    <HashRouter>
      <Providers>
        <SearchNavigationBridge />
        <Shell />
      </Providers>
    </HashRouter>
  );
}
