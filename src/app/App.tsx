import { HashRouter, Route, Routes, useLocation } from "react-router-dom";
import { Providers } from "@/app/providers";
import { Titlebar } from "@/components/shell/titlebar";
import { StorageAlert } from "@/components/shell/storage-alert";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { PageTransition } from "@/components/shell/page-transition";
import { HomePage } from "@/features/home/page";
import { ProjectsPage } from "@/features/projects/page";
import { PlansPage } from "@/features/plans/page";
import { FilesPage } from "@/features/files/page";
import { FeedsPage } from "@/features/feeds/page";
import { SettingsPage } from "@/features/settings/page";

/** 布局路由：/settings 为完全独立整页（无侧栏/顶栏），其余走后台布局 */
function Shell() {
  const location = useLocation();
  const standalone = location.pathname === "/settings";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Titlebar />
      {/* 落盘失败告警：挂在标题栏下方、所有布局之上 —— 它是应用级状态，
          设置页（standalone）也必须能看到 */}
      <StorageAlert />
      <div className="flex min-h-0 flex-1">
        {!standalone && <Sidebar />}
        <div className="flex min-w-0 flex-1 flex-col">
          {!standalone && <Topbar />}
          <main className="min-h-0 flex-1 overflow-hidden">
            <PageTransition>
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/plans" element={<PlansPage />} />
                <Route path="/files" element={<FilesPage />} />
                <Route path="/feeds" element={<FeedsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </PageTransition>
          </main>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <Providers>
        <Shell />
      </Providers>
    </HashRouter>
  );
}
