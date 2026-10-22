import { useEffect, useState } from "react";
import { inTauri } from "@/lib/tauri";
import { tbHarnessScan, tbMcpList, tbPromptList, tbSkillList } from "./api";

/** 侧栏 AI 组的数字角标。取不到就是 undefined，角标不渲染。 */
export interface ToolboxCounts {
  skills?: number;
  prompts?: number;
  mcp?: number;
  harness?: number;
}

/**
 * 数一遍工具箱里各有多少条。只在**离开**工具箱之后重数：
 * 用户在里面新建/删除完退回来时角标要跟上，而在里面操作时不必反复数。
 *
 * shortcut: 每次回到主界面都重跑一遍（含本机工具扫描，最贵的一步）；
 *           条目上到几百条、或扫描明显卡顿时再改成事件驱动的失效通知。
 */
export function useToolboxCounts(pathname: string): ToolboxCounts {
  const [counts, setCounts] = useState<ToolboxCounts>({});

  useEffect(() => {
    // 浏览器预览没有 Tauri：invoke 会 reject，角标留空即可
    if (!inTauri || pathname.startsWith("/toolbox")) return;
    let alive = true;
    void Promise.all([tbSkillList(), tbPromptList(), tbMcpList(), tbHarnessScan()])
      .then(([skills, prompts, mcp, harness]) => {
        if (!alive) return;
        setCounts({
          skills: skills.length,
          prompts: prompts.length,
          mcp: mcp.length,
          harness: harness.filter((report) => report.exists).length,
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [pathname]);

  return counts;
}
