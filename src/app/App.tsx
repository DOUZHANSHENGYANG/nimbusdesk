import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { lazy, Suspense, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { inTauri } from "@/lib/tauri";
import { Providers } from "@/app/providers";
import { Titlebar } from "@/components/shell/titlebar";
import { StorageAlert } from "@/components/shell/storage-alert";
import { SkillUpdateDock } from "@/ahub/components/SkillUpdateCenter";
import { AiJobsDock } from "@/ahub/components/AiJobsDock";
import { Sidebar } from "@/components/shell/sidebar";
import { PageTransition } from "@/components/shell/page-transition";
import { HomePage } from "@/features/home/page";
import { OrganizationActivity } from "@/features/knowledge/organization-activity";
import { ScheduleRuntime } from "@/features/schedule/runtime";
import { AppContextMenu } from "@/components/shell/app-context-menu";
import { EndfieldSplash } from "@/components/shell/endfield-splash";

/**
 * 路由级按需加载。
 *
 * 首页（落点）保持静态：它是启动后第一屏，懒加载只会把首屏往后推。
 * 其余页面各自一个 chunk —— 它们之间的依赖差得很远（工具箱四页带着 ahub 全套与
 * AI SDK，文件页带 dnd，设置页带整套备份/导入），以前全塞在一个 3.6 MB 的包里，
 * 打开应用就得先解析完「技能市场」「禅道」「备份恢复」这些可能这辈子都不点的代码。
 *
 * 页面内容里没有 Suspense 边界的话，切换瞬间会白一下；这里统一在
 * `PageTransition` 内层兜住，过渡动画（GSAP，依赖 pathname）照旧只在路由变化时跑一次。
 */
const ProjectsPage = lazy(() => import("@/features/projects/page").then((m) => ({ default: m.ProjectsPage })));
const PlansPage = lazy(() => import("@/features/plans/page").then((m) => ({ default: m.PlansPage })));
const GithubPage = lazy(() => import("@/features/projects/github-page").then((m) => ({ default: m.GithubPage })));
const FilesPage = lazy(() => import("@/features/files/page").then((m) => ({ default: m.FilesPage })));
const FeedsPage = lazy(() => import("@/features/feeds/page").then((m) => ({ default: m.FeedsPage })));
const ResearchPage = lazy(() => import("@/features/research/page").then((m) => ({ default: m.ResearchPage })));
const SettingsPage = lazy(() => import("@/features/settings/page").then((m) => ({ default: m.SettingsPage })));
const SettingsLayout = lazy(() => import("@/features/settings/layout").then((m) => ({ default: m.SettingsLayout })));
const KnowledgePage = lazy(() => import("@/features/knowledge/page").then((m) => ({ default: m.KnowledgePage })));
const ToolsPage = lazy(() => import("@/features/tools/page").then((m) => ({ default: m.ToolsPage })));
const TOOLBOX_HOME = "/toolbox/prompts";

const AhubToolboxPage = lazy(() =>
  import("@/features/agenthub/ahub-host-toolbox").then((m) => ({ default: m.AhubToolboxPage })),
);
const AgentPage = lazy(() => import("@/features/agent/panel").then((m) => ({ default: m.AgentPage })));
const CanvasPage = lazy(() => import("@/features/canvas/page").then((m) => ({ default: m.CanvasPage })));
const SchedulePage = lazy(() => import("@/features/schedule/page").then((m) => ({ default: m.SchedulePage })));

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
  const standalone = location.pathname.startsWith("/settings");

  return (
    <AppContextMenu>
    <div className="flex h-full flex-col overflow-hidden">
      <Titlebar />
      {/* 落盘失败告警：挂在标题栏下方、所有布局之上 —— 它是应用级状态，
          设置页（standalone）也必须能看到 */}
      <StorageAlert />
      <SkillUpdateDock />
      <AiJobsDock />
      <OrganizationActivity />
      {/*
        舞台：窗底（--background，也就是 body 的底）露在四边与两块之间，
        中间是**内容面**（标准材质，圆角），侧栏是浮在旁边的**玻璃功能层**。
        两层材质就在这一处对齐：窗底 → 内容面 → 玻璃功能层。
      */}
      <div className="app-stage flex min-h-0 flex-1 gap-2.5 p-2.5">
        {!standalone && <Sidebar />}
        <main className="app-main relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--pr-radius-xl)]">
          <PageTransition>
            <Suspense fallback={null}>
              <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/plans" element={<PlansPage />} />
              <Route path="/github" element={<GithubPage />} />
              {/* 路由按侧栏分区归位：AI 区 /ai/*，工具区 /tools/*。
                  旧路径保留重定向 —— 搜索深链、通知、历史书签都还指向它们。 */}
              <Route path="/files" element={<Navigate to="/tools/files" replace />} />
              <Route path="/feeds" element={<Navigate to="/tools/feeds" replace />} />
              <Route path="/knowledge" element={<Navigate to="/ai/knowledge" replace />} />
              <Route path="/tools/files" element={<FilesPage />} />
              <Route path="/tools/feeds" element={<FeedsPage />} />
<Route path="/tools/research" element={<ResearchPage />} />
              <Route path="/ai/knowledge" element={<KnowledgePage />} />
              <Route path="/tools" element={<ToolsPage />} />
              {/* 插件管理 / 运行时：一个入口一条路由，页签是路径参数。
                  深链形状不变（/toolbox/skills、/toolbox/sessions…），但渲染只此一处。 */}
              <Route path="/toolbox" element={<Navigate to={TOOLBOX_HOME} replace />} />
              <Route path="/toolbox/:tab" element={<AhubToolboxPage />} />
              <Route path="/agent" element={<Navigate to="/ai/agent" replace />} />
              <Route path="/canvas" element={<Navigate to="/tools/canvas" replace />} />
              <Route path="/schedules" element={<Navigate to="/ai/schedules" replace />} />
              <Route path="/ai/agent" element={<AgentPage />} />
              <Route path="/ai/schedules" element={<SchedulePage />} />
              <Route path="/tools/canvas" element={<CanvasPage />} />
              {/* 设置：左侧是与首页同一套侧栏（NavList），右侧按路由渲染内容。
                  每个功能一块独立设置页，深链形状 /settings/<area>[/<leaf>]。 */}
              <Route path="/settings" element={<SettingsLayout />}>
                <Route index element={<SettingsPage section="system" />} />
                <Route path="plans" element={<SettingsPage section="plans" />} />
                <Route path="ai/models" element={<SettingsPage section="ai-models" />} />
                <Route path="ai/knowledge" element={<SettingsPage section="ai-knowledge" />} />
                <Route path="tools/search" element={<SettingsPage section="search" />} />
                <Route path="tools/feeds" element={<SettingsPage section="feeds" />} />
                <Route path="tools/desktop" element={<SettingsPage section="desktop" />} />
                <Route path="shortcuts" element={<SettingsPage section="shortcuts" />} />
                <Route path="about" element={<SettingsPage section="about" />} />
              </Route>
              </Routes>
            </Suspense>
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
      {/* 定时任务的委托动作监听器：引擎随时可能触发，它必须全局在岗，
          挂在页面里的话——你不在 /schedules 时触发的任务会等满超时然后失败。 */}
      <ScheduleRuntime />
        <Shell />
        <EndfieldSplash />
      </Providers>
    </HashRouter>
  );
}
