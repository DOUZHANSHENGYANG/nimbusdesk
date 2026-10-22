import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
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
import { AhubPromptsPage } from "@/features/agenthub/ahub-host-prompts";
import { AhubMcpPage } from "@/features/agenthub/ahub-host";
import { SkillsPage } from "@/features/agenthub/skills-page";
import { AhubHarnessPage } from "@/features/agenthub/ahub-host-harness";
import { AgentPage } from "@/features/agent/panel";
import { AppContextMenu } from "@/components/shell/app-context-menu";

function SearchNavigationBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!inTauri) return;
    let active = true;
    const subscription = listen<string>("search://navigate", ({ payload }) => {
      if (active && /^\/(plans|knowledge|feeds|files|projects|tools|settings)(\?|$)/.test(payload)) navigate(payload);
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
      {/*
        舞台：窗底（--background，也就是 body 的底）露在四边与两块之间，
        中间是**内容面**（标准材质，圆角），侧栏是浮在旁边的**玻璃功能层**。
        两层材质就在这一处对齐：窗底 → 内容面 → 玻璃功能层。
      */}
      <div className="flex min-h-0 flex-1 gap-2.5 p-2.5">
        {!standalone && <Sidebar />}
        <main className="mat-surface relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--pr-radius-xl)]">
          <PageTransition>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/plans" element={<PlansPage />} />
              <Route path="/files" element={<FilesPage />} />
              <Route path="/feeds" element={<FeedsPage />} />
              <Route path="/knowledge" element={<KnowledgePage />} />
              <Route path="/tools" element={<ToolsPage />} />
              {/* 工具箱拆成四个独立页（与源侧一致）；旧的单页路由保留为跳转 */}
              <Route path="/toolbox" element={<Navigate to="/toolbox/skills" replace />} />
              <Route path="/toolbox/skills" element={<SkillsPage />} />
              <Route path="/toolbox/prompts" element={<AhubPromptsPage />} />
              <Route path="/toolbox/mcp" element={<AhubMcpPage />} />
              <Route path="/toolbox/harness" element={<AhubHarnessPage />} />
              <Route path="/agent" element={<AgentPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </PageTransition>
        </main>
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
