import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Eye, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAgent } from "../store";

import type { ModelParameters } from "@/features/ai/core";

/** 一行参数摘要：只列真的设置了的值，没设就不显示（别假装有默认值）。 */
function parametersLabel(parameters: ModelParameters): string {
  return (["temperature", "topP", "maxTokens", "reasoningEffort"] as const)
    .filter((key) => parameters[key] !== undefined)
    .map((key) => `${key}=${String(parameters[key])}`)
    .join(" · ");
}

/**
 * 模型选择器：列出**所有已配置服务商 × 它们的模型**，切换后当前会话立刻用新模型
 * 继续（store 会重建 ToolLoopAgent，历史消息原样带过去）。
 *
 * 一个都没有时不显示禁用壳子，而是给一句去哪儿配 —— 免得用户对着灰按钮猜。
 */
export function ModelPicker({ variant = "header" }: { variant?: "header" | "composer" }) {
  const { t } = useTranslation();
  const options = useAgent((state) => state.options);
  const providerId = useAgent((state) => state.providerId);
  const model = useAgent((state) => state.model);
  const status = useAgent((state) => state.status);
  const selectModel = useAgent((state) => state.selectModel);
  const guide = useAgent((state) => state.guide);
  const busy = status === "submitted" || status === "streaming";

  if (options.length === 0) {
    return variant === "header" ? null : <span className="agent-model-chip">{t("agent.model.none")}</span>;
  }

  const providers = [...new Set(options.map((item) => item.providerId))];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={variant === "composer" ? "agent-model-chip" : undefined}
          disabled={guide}
          title={t("agent.model.switchHint")}
        >
          <Wrench />
          <span className="agent-model-name">{model || t("agent.model.none")}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="agent-model-menu">
        {providers.map((id) => {
          const items = options.filter((item) => item.providerId === id);
          return (
            <div key={id}>
              <DropdownMenuLabel className="agent-model-group">{items[0].providerName}</DropdownMenuLabel>
              {items.map((item) => {
                const active = item.providerId === providerId && item.modelId === model;
                const parameters = parametersLabel(item.parameters);
                return (
                  <DropdownMenuItem
                    key={`${item.providerId}::${item.modelId}`}
                    onSelect={() => {
                      if (!active) void selectModel(item.providerId, item.modelId);
                    }}
                  >
                    <Check style={{ opacity: active ? 1 : 0 }} />
                    <span className="agent-model-item">
                      <span className="agent-model-item-name">
                        {item.modelId}
                        {item.vision && <Eye className="agent-model-vision" aria-label={t("agent.model.vision")} />}
                      </span>
                      {parameters && <span className="agent-model-item-params">{parameters}</span>}
                    </span>
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator />
            </div>
          );
        })}
        {busy && <p className="agent-model-note">{t("agent.model.busyNote")}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
