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
 * 还没有预设时整块不渲染 —— 空的栏只会让人疑惑，首个预设由
 * 批量工具条的「保存为预设」创建，出现后这里自然亮起。
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

  return (
    <section className="mb-3 flex w-full flex-col rounded-lg border border-border bg-surface/60 p-2">
      <header className="mb-1.5 flex items-center gap-1.5">
        <Layers className="size-3.5 text-ink-3" />
        <span className="text-[11px] font-semibold text-foreground">{t("preset.title")}</span>
        <span className="ml-auto font-mono text-[9.5px] text-ink-3">{items.length}</span>
        <button
          type="button"
          title={t("preset.manage")}
          aria-label={t("preset.manage")}
          onClick={onManage}
          className="rounded p-0.5 text-ink-3 hover:bg-surface-2 hover:text-foreground"
        >
          <Settings2 className="size-3" />
        </button>
      </header>

      <button
        type="button"
        aria-pressed={selectedId === null}
        onClick={() => onSelect(null)}
        className={cn(
          "flex h-6 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[11px] transition-colors",
          selectedId === null
            ? "bg-primary-soft font-medium text-primary"
            : "text-ink-2 hover:bg-surface-2 hover:text-foreground",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{t("preset.all")}</span>
        <span className="shrink-0 font-mono text-[9.5px] opacity-60">{total}</span>
      </button>

      {items.length === 0 ? null : (
        <div className="mt-0.5 flex flex-col gap-px">
          {items.map((p) => {
            const active = p.id === selectedId;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={active}
                title={p.description || p.name}
                onClick={() => onSelect(active ? null : p.id)}
                className={cn(
                  "flex h-6 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[11px] transition-colors",
                  active
                    ? "bg-primary-soft font-medium text-primary"
                    : "text-ink-2 hover:bg-surface-2 hover:text-foreground",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {p.stale > 0 ? (
                  <span
                    className="shrink-0 rounded-full bg-danger/12 px-1 font-mono text-[9px] leading-4 text-danger"
                    title={t("preset.reasonMissing")}
                  >
                    {p.stale}
                  </span>
                ) : null}
                <span className="shrink-0 font-mono text-[9.5px] opacity-60">{p.count}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
