import { Layers, Settings2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/ahub/components/ui/button";
import type { Preset } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

/**
 * Skills 页顶部预设栏：横向胶囊列表 + 「全部」/「管理」入口。
 *
 * 人因要点：这一栏只做筛选与入口，不做增删改 ——
 * 写操作全在管理面板里，避免顶部一行误触。
 */
export function PresetBar({
  presets,
  selectedId,
  liveDirs,
  onSelect,
  onManage,
}: {
  presets: Preset[];
  /** 当前筛选中的预设 id；null = 未按预设筛选 */
  selectedId: string | null;
  /** 技能池里仍存在的目录名 —— 用来标出失效成员 */
  liveDirs: Set<string>;
  onSelect: (id: string | null) => void;
  onManage: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      data-anim
      className="mb-3 flex shrink-0 flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface/60 px-3 py-2"
    >
      <span className="mr-0.5 flex shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
        <Layers className="size-3.5" />
        {t("preset.title")}
      </span>

      {presets.length === 0 ? (
        <span className="min-w-0 flex-1 text-[11px] text-ink-3" title={t("preset.emptyHint")}>
          {t("preset.empty")}
        </span>
      ) : (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {presets.map((p) => {
            const active = p.id === selectedId;
            const empty = p.skillDirNames.length === 0;
            const staleCount = p.skillDirNames.filter((d) => !liveDirs.has(d)).length;
            return (
              <button
                key={p.id}
                type="button"
                // 再点一次当前预设 = 取消该预设筛选
                onClick={() => onSelect(active ? null : p.id)}
                title={
                  staleCount
                    ? `${p.description || p.name} · ${t("preset.stale")} ${staleCount}`
                    : p.description || p.name
                }
                className={cn(
                  "flex max-w-[240px] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium outline-none transition-colors",
                  active
                    ? "border-primary bg-primary-soft text-primary"
                    : "border-border text-ink-2 hover:border-primary/40 hover:text-foreground",
                )}
              >
                <span className="min-w-0 truncate">{p.name}</span>
                <span className="shrink-0 tabular-nums opacity-60">{p.skillDirNames.length}</span>
                {staleCount ? (
                  <span
                    className="shrink-0 rounded-full bg-danger/12 px-1.5 text-[10px] leading-4 text-danger"
                    title={t("preset.reasonMissing")}
                  >
                    {staleCount} {t("preset.stale")}
                  </span>
                ) : null}
                {empty ? (
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-1.5 text-[10px] leading-4",
                      active ? "bg-primary/15" : "bg-surface-2 text-ink-3",
                    )}
                  >
                    {t("preset.emptyBadge")}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {/* 只清预设筛选，不动搜索 / 标签 / 来源；没有在筛时无事可清 → 置灰 */}
        <Button
          size="sm"
          variant="secondary"
          className="h-7 justify-center text-[11px]"
          disabled={selectedId === null}
          onClick={() => onSelect(null)}
        >
          <X className="size-3.5" />
          {t("preset.all")}
        </Button>
        <Button size="sm" variant="secondary" className="h-7 justify-center text-[11px]" onClick={onManage}>
          <Settings2 className="size-3.5" />
          {t("preset.manage")}
        </Button>
      </div>
    </div>
  );
}
