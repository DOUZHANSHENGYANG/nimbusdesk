import { Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@/ahub/components/ui/input";
import { cn } from "@/ahub/lib/utils";

/**
 * 统一的搜索框。
 *
 * 各页面此前各写一套（宽度 52/56、图标 3.5/4、清空按钮有无都不一致），
 * 造成同一动作在不同页面长得不一样。这里收敛成一种版式：
 *   - 高度与 Input 一致（h-9）
 *   - 左侧放大镜、右侧清空（有内容时出现）
 *   - 宽度由 `className` 覆盖，默认 56（14rem）
 *
 * 语义上只负责"输入框 + 清空"，不关心筛选逻辑 —— 逻辑留在各页面。
 */
export function SearchBar({
  value,
  onChange,
  placeholder,
  className,
  autoFocus,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? t("common.search")}
        autoFocus={autoFocus}
        className="h-9 pl-8 pr-8"
      />
      {value ? (
        <button
          type="button"
          title={t("common.clear")}
          aria-label={t("common.clear")}
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * 页面顶部的筛选栏容器：把「搜索 / 标签 / 其他筛选 / 视图切换」放在同一条横线上。
 *
 * 统一各页面的筛选区版式，降低"每个页面长得都不一样"的认知成本。
 * 窄窗口自动换行，不挤压内容。
 */
export function FilterBar({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mb-3 flex flex-wrap items-center gap-2", className)}>{children}</div>
  );
}
