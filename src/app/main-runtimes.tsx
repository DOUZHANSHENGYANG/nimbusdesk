import { useEffect } from "react";
import { openTodoPaper } from "@/lib/tauri";
import { paperGeometryFor, usePapers } from "@/stores/papers";
import { useReminderLoop } from "@/features/plans/reminder";
import { FeedsRuntime } from "@/features/feeds/runtime";
import { DesktopRuntime } from "@/features/files/desktop-runtime";
import { DirectoryMappingRuntime } from "@/features/files/directory-mapping-runtime";
import { EdgeRuntime } from "@/features/desktop/edge-runtime";
import { KnowledgeRuntime } from "@/features/knowledge/runtime";
import { SearchRuntime } from "@/features/search";
import { ProjectRuntime } from "@/features/projects/runtime";
import { ZentaoRuntime } from "@/features/projects/zentao-runtime";

/**
 * 主窗口常驻的后台任务。
 *
 * 从 `providers.tsx` 拆出来的原因：这些运行时（项目/禅道/知识/搜索/资讯/桌面/目录映射/
 * 边缘坞/提醒/纸片恢复）只有主窗口需要，但以前是静态 import —— 栅栏、待办纸片、
 * 右键菜单、Dock 这些**独立小窗口**也会把整套逻辑连同它们的依赖一起加载。
 * 拆成独立模块后由主窗口 `lazy` 拉取，小窗口的首屏 JS 只剩自己的 UI。
 *
 * `ReminderLoop` 是 hook，不能直接当组件渲染，这里包一层。
 */
function ReminderLoop() {
  useReminderLoop();
  return null;
}

/**
 * 启动时恢复桌面待办纸片。
 *
 * 放在主窗口运行时里而不是计划页：纸片是常驻桌面的部件，用户上次开着它、
 * 这次打开应用停在主页，纸片也应该回来 —— 要求「先进一次计划页」才恢复，
 * 会让人以为纸片坏了。
 *
 * 必须等 persist **水合完成**再读，不能只等 setTimeout(0)：
 * 存储是异步的（走 Tauri IPC 读 JSON），宏任务早就跑完了、数据还没回来，
 * 结果读到空 papers、一个窗口都不恢复 —— 而且不报错，看起来就像功能没生效。
 * （这一点与本项目其他地方不同：settings 的启动逻辑刻意不依赖水合，
 *   因为那里只需要「默认值可用」；而这里必须拿到磁盘上的真实记录。）
 */
function PaperRestore() {
  useEffect(() => {
    const restore = () => {
      const { papers } = usePapers.getState();
      for (const [date, st] of Object.entries(papers)) {
        if (!st.open) continue;
        // 标题只在 Alt+Tab 里可见；用日期串而非空串，避免任务栏出现无名窗口
        /*
         * 先按**纸片几何**建窗，哪怕它是胶囊形态。
         *
         * 胶囊形态的窗口几何要等 CapsuleView 挂载后自己摆（它得先问显示器工作区），
         * 而建窗这一步是同步的、还没有窗口可问。这里给个纸片位置就足够了 ——
         * 胶囊挂载期间根节点 opacity 为 0，用户看不到这个中间态，摆好之后才显示出来。
         * 反过来「等算好位置再建窗」会把启动恢复拖成异步链。
         */
        void openTodoPaper(date, date, paperGeometryFor(date)).catch(() => undefined);
      }
    };

    /*
     * 刻意**不用** useRef 一次性门闩（SettingsSync 那种写法）。
     *
     * StrictMode 会让 effect → cleanup → effect 跑两遍：门闩在第一次就把标志置了，
     * 第二次直接 return，于是「取消订阅后不再重新订阅」，
     * 水合完成时回调早被摘掉，纸片永远不恢复 —— 而且不报错。
     * 这里改为「已水合就立刻执行，否则订阅并在 cleanup 里退订」，
     * 重复执行也安全：openTodoPaper 对已存在的窗口是聚焦而不是新建。
     */
    if (usePapers.persist.hasHydrated()) {
      restore();
      return;
    }
    return usePapers.persist.onFinishHydration(restore);
  }, []);
  return null;
}

export default function MainRuntimes() {
  return (
    <>
      <PaperRestore />
      <ReminderLoop />
      <ProjectRuntime />
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
