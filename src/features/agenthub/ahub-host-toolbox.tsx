import { Suspense, lazy, type ComponentType } from "react";
import { Navigate, useParams } from "react-router-dom";

/**
 * 插件管理 / 运行时：**一个路由**，页签是路径参数。
 *
 * 之前是五条平级路由（/toolbox/skills、/prompts、/mcp、/harness、/sessions），
 * 靠侧栏和页签去"装作"一页；现在真正的渲染入口只有一个 `/toolbox/:tab`——
 * 深链一个都不用改，因为它们本来就是同一形状的地址，但页面只剩一处挂载。
 *
 * 每个视图仍是独立的 lazy chunk，切页签才加载对应的那份，不把四个页面打进同一个包。
 */
const VIEWS = {
  skills: lazy(() => import("@/features/agenthub/ahub-host-skills").then((m) => ({ default: m.AhubSkillsPage }))),
  prompts: lazy(() => import("@/features/agenthub/ahub-host-prompts").then((m) => ({ default: m.AhubPromptsPage }))),
  mcp: lazy(() => import("@/features/agenthub/ahub-host").then((m) => ({ default: m.AhubMcpPage }))),
  harness: lazy(() => import("@/features/agenthub/ahub-host-harness").then((m) => ({ default: m.AhubHarnessPage }))),
  sessions: lazy(() => import("@/features/sessions/page").then((m) => ({ default: m.SessionsPage }))),
} satisfies Record<string, ComponentType>;

export type ToolboxTab = keyof typeof VIEWS;

export const TOOLBOX_TABS = Object.keys(VIEWS) as ToolboxTab[];

/** 合并入口的落地页：plugins 组与 runtime 组共用这一处。 */
export const TOOLBOX_HOME = "/toolbox/prompts";

export function AhubToolboxPage() {
  const { tab } = useParams();
  if (!tab || !(tab in VIEWS)) return <Navigate to={TOOLBOX_HOME} replace />;
  const View = VIEWS[tab as ToolboxTab];
  return (
    <Suspense fallback={null}>
      <View />
    </Suspense>
  );
}
