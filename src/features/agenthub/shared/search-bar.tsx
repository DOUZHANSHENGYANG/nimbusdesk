import { Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * 统一搜索框：左侧放大镜、右侧清空（有内容时才出现），高度与 Input 一致。
 * 只负责「输入 + 清空」，筛选逻辑留在各页面。
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
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder ?? t("toolbox.search")}
        autoFocus={autoFocus}
        className="h-9 pl-8 pr-8"
      />
      {value ? (
        <button
          type="button"
          title={t("toolbox.clear")}
          aria-label={t("toolbox.clear")}
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/** 页面顶部的筛选栏：搜索 / 标签 / 其他筛选 / 视图切换放在同一条横线上，窄窗口自动换行。 */
export function FilterBar({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mb-3 flex flex-wrap items-center gap-2", className)}>{children}</div>;
}
