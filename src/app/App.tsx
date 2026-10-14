import { HashRouter, Route, Routes } from "react-router-dom";
import { Providers } from "@/app/providers";
import { Titlebar } from "@/components/shell/titlebar";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { PageTransition } from "@/components/shell/page-transition";
import { HomePage } from "@/features/home/page";
import { ProjectsPage } from "@/features/projects/page";
import { PlansPage } from "@/features/plans/page";
import { FilesPage } from "@/features/files/page";
import { FeedsPage } from "@/features/feeds/page";
import { SettingsPage } from "@/features/settings/page";

/** 经典后台布局：标题栏 / 侧栏 / 顶栏 / 内容区 */
export default function App() {
  return (
    <HashRouter>
      <Providers>
        <div className="flex h-full flex-col overflow-hidden">
          <Titlebar />
          <div className="flex min-h-0 flex-1">
            <Sidebar />
            <div className="flex min-w-0 flex-1 flex-col">
              <Topbar />
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
      </Providers>
    </HashRouter>
  );
}
