import { useTranslation } from "react-i18next";
import { Check, CircleDot, ListChecks, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSettings } from "@/stores/settings";
import { AGENT_PRESETS, type AgentPreset } from "../composer-core";

const ICONS: Record<AgentPreset, typeof UserRound> = {
  build: UserRound,
  plan: ListChecks,
  ask: CircleDot,
};

/**
 * 智能体：三档预设，每档 = 一段 instructions 前缀 + 一组允许的工具
 * （见 composer-core 的 `PRESET_PREFIX` / `presetTools`）。
 *
 * 刻意**不做**「自由新建智能体」：那会把 v1 变成一套需要自己维护的编排系统，
 * 而这里真正要解决的只是「这一轮是改东西，还是只给方案，还是只回答」。
 */
export function PresetPicker() {
  const { t } = useTranslation();
  const preset = useSettings((state) => state.agentPreset);
  const setPreset = useSettings((state) => state.setAgentPreset);
  const Icon = ICONS[preset];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="agent-tool-btn"
        title={`${t("agent.preset.switchHint")}\n${t(`agent.preset.${preset}.hint`)}`}
        aria-label={`${t("agent.preset.title")}：${t(`agent.preset.${preset}.name`)}`}
      >
        <Icon />
        <span className="agent-tool-label">{t(`agent.preset.${preset}.name`)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="agent-menu w-auto min-w-64">
        <DropdownMenuLabel className="agent-menu-title">{t("agent.preset.title")}</DropdownMenuLabel>
        {AGENT_PRESETS.map((item) => {
          const active = item === preset;
          return (
            <DropdownMenuItem
              key={item}
              onSelect={() => {
                if (!active) setPreset(item);
              }}
            >
              <Check className="agent-menu-check" style={{ opacity: active ? 1 : 0 }} />
              <span className="agent-menu-item">
                <span className="agent-menu-name">{t(`agent.preset.${item}.name`)}</span>
                <span className="agent-menu-note">{t(`agent.preset.${item}.hint`)}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
