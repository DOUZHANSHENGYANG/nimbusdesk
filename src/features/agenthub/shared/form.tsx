import type { LabelHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export { Input } from "@/components/ui/input";

/** 多行输入。云台把它单独放在 ui/textarea.tsx，这里转发一次保持源侧同一个 import 口。 */
export { Textarea } from "@/components/ui/textarea";

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-xs font-medium text-ink-2", className)} {...props} />;
}

/** 「标签 + 控件 + 提示」的三段式字段容器。 */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label?: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? <Label>{label}</Label> : null}
      {children}
      {hint ? <p className="text-[11px] leading-relaxed text-ink-3">{hint}</p> : null}
    </div>
  );
}
