import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { inTauri } from "@/lib/tauri";
import { useAgent } from "../store";
import { ModelPicker } from "./model-picker";
import { SessionsMenu } from "./sessions-menu";

/** 顶栏：当前服务商地址与模型、连接状态、模型选择、会话菜单。 */
export function Status() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const baseUrl = useAgent((state) => state.baseUrl);
  const model = useAgent((state) => state.model);
  const status = useAgent((state) => state.status);
  const guide = useAgent((state) => state.guide);
  const state = status === "error" ? "error" : guide ? "guide" : status;

  return (
    <header className="agent-status">
      <div className="agent-status-identity">
        <span className="agent-dot" data-state={state} />
        <div className="agent-status-text">
          <h1>{t("agent.title")}</h1>
          {/* 换模型后这一行要跟着变：地址 + 模型就是「现在发去哪、用哪个」 */}
          <p title={baseUrl}>
            {model ? `${baseUrl} · ${model}` : t("agent.subtitle")}
          </p>
        </div>
      </div>
      <div className="agent-status-actions">
        <span className="agent-status-state" data-state={state}>
          {t(`agent.status.${state}`)}
        </span>
        <ModelPicker />
        <SessionsMenu />
      </div>
      {!inTauri && (
        <p className="agent-warning">
          <AlertTriangle />
          {t("agent.noDesktop")}
          <button type="button" onClick={() => navigate("/settings")}>{t("agent.guide.action")}</button>
        </p>
      )}
    </header>
  );
}
