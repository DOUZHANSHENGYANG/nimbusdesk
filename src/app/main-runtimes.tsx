import { FeedsRuntime } from "@/features/feeds/runtime";
import { DesktopRuntime } from "@/features/files/desktop-runtime";
import { DirectoryMappingRuntime } from "@/features/files/directory-mapping-runtime";
import { EdgeRuntime } from "@/features/desktop/edge-runtime";
import { KnowledgeRuntime } from "@/features/knowledge/runtime";
import { SearchRuntime } from "@/features/search";
import { ZentaoRuntime } from "@/features/projects/zentao-runtime";

/**
 * 主窗口常驻的后台任务。
 *
 * 从 `providers.tsx` 拆出来的原因：这些运行时（禅道/知识/搜索/资讯/桌面/目录映射/边缘坞）
 * 只有主窗口需要，但以前是静态 import —— 栅栏、右键菜单、Dock 这些**独立小窗口**
 * 也会把整套逻辑连同它们的依赖一起加载。
 * 拆成独立模块后由主窗口 `lazy` 拉取，小窗口的首屏 JS 只剩自己的 UI。
 */
export default function MainRuntimes() {
  return (
    <>
      <ZentaoRuntime />
      <KnowledgeRuntime />
      <SearchRuntime />
      <FeedsRuntime />
      <DesktopRuntime />
      <DirectoryMappingRuntime />
      <EdgeRuntime />
    </>
  );
}
