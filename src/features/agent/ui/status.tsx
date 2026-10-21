import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inTauri } from "@/lib/tauri";
import { useAgent } from "../store";

/** 顶栏：当前服务商与模型、连接状态、新会话。 */
export function Status() {
  const { t } = useTranslation();
  const providerName = useAgent((state) => state.providerName);
  const model = useAgent((state) => state.model);
  const status = useAgent((state) => state.status);
  const reset = useAgent((state) => state.reset);
  const count = useAgent((state) => state.messages.length);
  const state = status === "error" ? "error" : status;

  return (
    <header className="agent-status">
      <div className="agent-status-identity">
        <span className="agent-dot" data-state={state} />
        <div>
          <h1>{t("agent.title")}</h1>
          <p>{model ? `${providerName} · ${model}` : t("agent.subtitle")}</p>
        </div>
      </div>
      <div className="agent-status-actions">
        <span className="agent-status-state" data-state={state}>
          {t(`agent.status.${state}`)}
        </span>
        {count > 0 && (
          <Button size="sm" variant="ghost" onClick={reset}>
            <RotateCcw />
            {t("agent.newChat")}
          </Button>
        )}
      </div>
      {!inTauri && <p className="agent-warning">{t("agent.noDesktop")}</p>}
    </header>
  );
}
