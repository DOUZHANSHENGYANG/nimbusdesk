import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FolderOpen, Plug } from "lucide-react";
import { gsap, useGSAP } from "@/lib/gsap";
import { tbRoot, tbRootReveal, type TbRoots } from "./api";
import { HarnessView } from "./harness-view";
import { McpView } from "./mcp-view";
import { PromptsView } from "./prompts-view";
import { SkillsView } from "./skills-view";
import "./toolbox.css";

export type ToolboxSection = "skills" | "prompts" | "mcp" | "harness";

const VIEWS: Record<ToolboxSection, () => React.JSX.Element> = {
  skills: SkillsView,
  prompts: PromptsView,
  mcp: McpView,
  harness: HarnessView,
};

/**
 * 工具箱的一个页面（技能 / 提示词 / MCP / 本机工具）。
 *
 * 四个页面各有各的路由，不再用一个页面里的标签切换 —— 与源侧 AgentHub 一致：
 * 每页是自己的标题、自己的动作区，侧栏就是它们之间的导航。
 *
 * 与「工具」页（AI 文本小工具）是两件事：那页每次输入都要过一次模型，
 * 这页只做本地文件与配置的管理，不联网、不调模型。
 */
export function ToolboxPage({ section }: { section: ToolboxSection }) {
  const { t } = useTranslation();
  const scope = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<TbRoots | null>(null);
  const View = VIEWS[section];

  useEffect(() => {
    void tbRoot().then(setRoot).catch(() => undefined);
  }, []);

  // 与源侧 PageShell 同一套入场：先头部、后内容，位移 + 淡入
  useGSAP(
    () => {
      gsap.from("[data-anim]", { opacity: 0, y: 12, duration: 0.42, stagger: 0.05, ease: "power2.out", clearProps: "all" });
    },
    { dependencies: [section], scope },
  );

  return (
    <div ref={scope} className="toolbox workbench-ui">
      <div data-anim className="toolbox-head">
        <div className="min-w-0">
          <h1>{t(`toolbox.section.${section}.title`)}</h1>
          <p>{t(`toolbox.section.${section}.subtitle`)}</p>
        </div>
        <div className="toolbox-head-actions">
          <span className="toolbox-hint">
            <Plug />
            {t("toolbox.localOnly")}
          </span>
          {root && (
            <button
              type="button"
              className="toolbox-root"
              title={root.root}
              onClick={() => void tbRootReveal().catch((error) => toast.error(String(error)))}
            >
              <FolderOpen />
              <code>{root.root}</code>
            </button>
          )}
        </div>
      </div>

      <div data-anim className="toolbox-body">
        <View />
      </div>
    </div>
  );
}
