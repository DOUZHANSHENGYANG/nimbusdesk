import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FolderOpen, KeyRound, Plug, Sparkles } from "lucide-react";
import { tbRoot, tbRootReveal, type TbRoots } from "./api";
import { McpView } from "./mcp-view";
import { PromptsView } from "./prompts-view";
import { SkillsView } from "./skills-view";
import "./toolbox.css";

type Tab = "skills" | "prompts" | "mcp";

/**
 * 工具箱：把散落在各 AI 工具里的技能、提示词、MCP 配置收拢到一处。
 *
 * 与「工具」页（AI 文本小工具）是两件事：那页每次输入都要过一次模型，
 * 这页只做本地文件与配置的管理，不联网、不调模型。
 */
export function ToolboxPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("skills");
  const [root, setRoot] = useState<TbRoots | null>(null);

  useEffect(() => {
    void tbRoot().then(setRoot).catch(() => undefined);
  }, []);

  const tabs: { id: Tab; label: string; icon: typeof Sparkles }[] = [
    { id: "skills", label: t("toolbox.tabSkills"), icon: Sparkles },
    { id: "prompts", label: t("toolbox.tabPrompts"), icon: KeyRound },
    { id: "mcp", label: t("toolbox.tabMcp"), icon: Plug },
  ];

  return (
    <div className="toolbox workbench-ui">
      <header className="toolbox-header">
        <div>
          <h1>{t("toolbox.title")}</h1>
          <p>{t("toolbox.subtitle")}</p>
        </div>
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
      </header>

      <nav className="toolbox-tabs" aria-label={t("toolbox.title")}>
        {tabs.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
            <Icon />
            {label}
          </button>
        ))}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="toolbox-hint" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Plug className="size-3.5" />
          {t("toolbox.localOnly")}
        </span>
      </nav>

      <div className="toolbox-body">
        {tab === "skills" ? <SkillsView /> : tab === "prompts" ? <PromptsView /> : <McpView />}
      </div>
    </div>
  );
}
