import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FolderOpen } from "lucide-react";
import { gsap, useGSAP } from "@/lib/gsap";
import { tbRoot, tbRootReveal, type TbRoots } from "./api";
import "./toolbox.css";

export type ToolboxSection = "skills" | "prompts" | "mcp" | "harness";

/**
 * 工具箱页面的外壳：标题 + 动作区 + 内容。
 *
 * 四个页面各有各的路由和外壳 —— 与源侧 AgentHub 一致：每页是自己的标题、
 * 自己的动作区，侧栏就是它们之间的导航，页面里不再有第二层标签。
 *
 * 与「工具」页（AI 文本小工具）是两件事：那页每次输入都要过一次模型，
 * 这几页只做本地文件与配置的管理，不联网、不调模型。
 */
export function ToolboxPage({
  section,
  actions,
  children,
}: {
  section: ToolboxSection;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const scope = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<TbRoots | null>(null);

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
        <div className="toolbox-head-title">
          <h1>{t(`toolbox.section.${section}.title`)}</h1>
          <p>{t(`toolbox.section.${section}.subtitle`)}</p>
        </div>
        <div className="toolbox-head-actions">
          {root && (
            <button
              type="button"
              className="toolbox-root"
              title={`${root.root}\n${t("toolbox.localOnly")}`}
              aria-label={t("toolbox.reveal")}
              onClick={() => void tbRootReveal().catch((error) => toast.error(String(error)))}
            >
              <FolderOpen />
            </button>
          )}
          {actions}
        </div>
      </div>

      <div data-anim className="toolbox-body">
        {children}
      </div>
    </div>
  );
}
