import { useTranslation } from "react-i18next";
import { Check, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSettings } from "@/stores/settings";
import { PERMISSION_MODES, permissionIsRisky, type PermissionMode } from "../composer-core";

/** 档位 → 图标：一眼看出「现在有多松」，窄宽度藏掉文字后仍然可读。 */
const ICONS: Record<PermissionMode, typeof Shield> = {
  ask: Shield,
  "readonly-auto": ShieldCheck,
  "all-auto": ShieldAlert,
};

/**
 * 权限：**写不写本机数据**由这一颗按钮决定，所以它必须一直在工具行里，不能藏进
 * 设置页。三档（每次问 / 只读自动 / 全部自动）持久化在 settings，切换立刻生效 ——
 * 审批结论是在「真正要执行这个工具」那一刻现算的（见 model.ts 的 toolApproval）。
 *
 * 「全部自动」是唯一会不问就写的档：按钮整颗染成警告色并带一个小点，
 * 悬停文案里写明风险，不让它看起来和另外两档一样无害。
 */
export function PermissionPicker() {
  const { t } = useTranslation();
  const mode = useSettings((state) => state.agentPermission);
  const setMode = useSettings((state) => state.setAgentPermission);
  const risky = permissionIsRisky(mode);
  const Icon = ICONS[mode];
  const name = t(`agent.permission.${mode}.name`);
  const hint = t(`agent.permission.switchHint`);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="agent-tool-btn"
        data-risky={risky || undefined}
        title={`${hint}\n${name} · ${t(`agent.permission.${mode}.hint`)}`}
        aria-label={`${t("agent.permission.title")}：${name}`}
      >
        <Icon />
        {risky && <span className="agent-tool-alert" aria-hidden="true" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="agent-menu w-auto min-w-64">
        <DropdownMenuLabel className="agent-menu-title">{t("agent.permission.title")}</DropdownMenuLabel>
        {PERMISSION_MODES.map((item) => {
          const active = item === mode;
          return (
            <DropdownMenuItem
              key={item}
              data-risky={permissionIsRisky(item) || undefined}
              onSelect={() => {
                if (!active) setMode(item);
              }}
            >
              <Check className="agent-menu-check" style={{ opacity: active ? 1 : 0 }} />
              <span className="agent-menu-item">
                <span className="agent-menu-name">{t(`agent.permission.${item}.name`)}</span>
                <span className="agent-menu-note">{t(`agent.permission.${item}.hint`)}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
