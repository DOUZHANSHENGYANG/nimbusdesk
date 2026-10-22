import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ToolButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  /** 可选的短文字（10.5–11px）。窄宽度下整段隐藏，只留图标。 */
  label?: string;
  /** 有值/开启态：文字照常但颜色提到 foreground。 */
  active?: boolean;
  /** 危险态（权限「全部自动」）：整颗按钮染色，并在图标上加一个小点。 */
  risky?: boolean;
}

/**
 * 输入区工具行里的小按钮：15px 图标 + 可选短文字、高 28、圆角 8。
 *
 * 刻意**不用** shadcn 的 `Button`：它的尺寸档位（h-6/7/8…）与内边距是给正文
 * 按钮定的，套在这里会变成一排大按钮，而这排东西应该是「贴着输入框的图标」。
 * 样式全部落在 `agent.css` 的 `.agent-tool-btn` 上，一处改动九个控件同时生效。
 */
export function ToolButton({ icon, label, active, risky, className, type, ...rest }: ToolButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={className ? `agent-tool-btn ${className}` : "agent-tool-btn"}
      data-active={active || undefined}
      data-risky={risky || undefined}
      {...rest}
    >
      {icon}
      {label ? <span className="agent-tool-label">{label}</span> : null}
      {risky ? <span className="agent-tool-alert" aria-hidden="true" /> : null}
    </button>
  );
}
