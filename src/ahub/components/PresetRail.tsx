import { Layers, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/ahub/lib/utils";

export interface PresetRailItem {
  id: string;
  name: string;
  description: string;
  /** 成员数 */
  count: number;
  /** 已经不存在的成员数 */
  stale: number;
}

/**
 * 左侧预设栏：预设是「我常用的一组东西」（skill / mcp 各自的自由组合），
 * 比「按工具」更接近日常使用。
 *
 * 只做筛选与入口；增删改全在管理面板里，避免侧栏误触。
 * 还没有预设时整块不渲染 —— 空的栏只会让人疑惑，首个预设由批量工具条的
 * 「保存为预设」创建，出现后这里自然亮起。
 *
 * 排版与标签栏保持一致：一层外框 + 扁平行（h-7，计数用 tabular mono 靠右），
 * 不做卡片套卡片 —— 两栏并排时嵌套盒子会把留白吃光。
 */
export function PresetRail({
  items,
  selectedId,
  onSelect,
  onManage,
  total,
}: {
  items: PresetRailItem[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onManage: () => void;
  /** 「全部」行显示的总数 */
  total: number;
}) {
  const { t } = useTranslation();

  if (items.length === 0) return null;

  const row = (id: string | null, name: string, count: number, stale = 0, title?: string) => {
    const active = id === selectedId;
    return (
      <button
        key={id ?? "__all"}
        type="button"
        aria-pressed={active}
        title={title}
        onClick={() => onSelect(active && id ? null : id)}
        className={cn(
          "flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[11px] transition-colors",
          active
            ? "bg-primary-soft font-medium text-primary"
            : "text-ink-2 hover:bg-surface-2 hover:text-foreground",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {stale > 0 ? (
          <span
            className="shrink-0 rounded-full bg-danger/12 px-1 font-mono text-[9.5px] leading-4 text-danger"
            title={t("preset.reasonMissing")}
          >
            {stale}
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-[10px] text-ink-3">{count}</span>
      </button>
    );
  };

  return (
    <section className="rounded-xl border border-border bg-surface/40">
      <header className="flex items-center gap-1.5 px-2 py-1.5">
        <Layers className="size-3 shrink-0 text-ink-3" />
        <span className="truncate text-[11px] font-medium text-ink-2">{t("preset.title")}</span>
        <span className="shrink-0 font-mono text-[10px] text-ink-3">{items.length}</span>
        <button
          type="button"
          title={t("preset.manage")}
          aria-label={t("preset.manage")}
          onClick={onManage}
          className="ml-auto shrink-0 rounded p-0.5 text-ink-3 hover:bg-surface-2 hover:text-foreground"
        >
          <Settings2 className="size-3" />
        </button>
      </header>

      <div className="flex flex-col gap-0.5 border-t border-border/60 p-1">
        {row(null, t("preset.all"), total)}
        {items.map((p) => row(p.id, p.name, p.count, p.stale, p.description || p.name))}
      </div>
    </section>
  );
}
