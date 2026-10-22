import { useTranslation } from "react-i18next";
import { Brain, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAgent } from "../store";
import { useSettings } from "@/stores/settings";
import { THINKING_LEVELS, resolveReasoningEffort, thinkingLabel } from "../composer-core";

/**
 * 思考等级：`auto` = 跟随服务商模型里配的 `reasoningEffort`（没配就一个字段都不发），
 * 其余档位直接覆盖它 —— 覆盖发生在 provider 的 `transformRequestBody` 里，
 * 所以切档不需要重建 transport，下一次请求就生效。
 *
 * 按钮上显示的是**实际生效的值**：auto 且模型配了 high 时就写 `high`，
 * 而不是写一个「auto」，让人猜到底发出去的是什么。
 */
export function ThinkingPicker() {
  const { t } = useTranslation();
  const level = useSettings((state) => state.agentThinking);
  const setLevel = useSettings((state) => state.setAgentThinking);
  const options = useAgent((state) => state.options);
  const providerId = useAgent((state) => state.providerId);
  const model = useAgent((state) => state.model);
  const configured = options.find((item) => item.providerId === providerId && item.modelId === model)
    ?.parameters.reasoningEffort;
  const effective = thinkingLabel(level, configured);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="agent-tool-btn"
        title={`${t("agent.thinkingLevel.switchHint")}\n${t("agent.thinkingLevel.current")}：${effective}`}
        aria-label={`${t("agent.thinkingLevel.title")}：${effective}`}
      >
        <Brain />
        <span className="agent-tool-label">{effective}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="agent-menu w-auto min-w-56">
        <DropdownMenuLabel className="agent-menu-title">{t("agent.thinkingLevel.title")}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => setLevel("auto")}>
          <Check className="agent-menu-check" style={{ opacity: level === "auto" ? 1 : 0 }} />
          <span className="agent-menu-item">
            <span className="agent-menu-name">{t("agent.thinkingLevel.auto")}</span>
            <span className="agent-menu-note">
              {configured ? t("agent.thinkingLevel.autoValue", { value: configured }) : t("agent.thinkingLevel.autoNone")}
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {THINKING_LEVELS.filter((item) => item !== "auto").map((item) => (
          <DropdownMenuItem key={item} onSelect={() => setLevel(item)}>
            <Check className="agent-menu-check" style={{ opacity: level === item ? 1 : 0 }} />
            <span className="agent-menu-name">{item}</span>
          </DropdownMenuItem>
        ))}
        {configured && resolveReasoningEffort(level, configured) !== configured && (
          <p className="agent-menu-foot">{t("agent.thinkingLevel.override", { value: configured })}</p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
