import { CircleSlash, Wrench, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { HarnessIcon } from "@/ahub/components/HarnessIcon";
import type { HarnessReport } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

/**
 * 左栏「工具」区块：按 harness 收窄技能列表。
 *
 * 刻意不回到页头的药丸行 —— 那一行已经被标签、视图、批量按钮占满，
 * 再加一排工具筛选会把筛选台撑成两屏。放在卡片仓下面与标签同层，
 * 竖着排也正好容得下「未接入」这种兜底项。
 */
export function HarnessFilterRail({
  reports,
  counts,
  total,
  unassigned,
  value,
  onChange,
}: {
  /** null = 还没扫完 */
  reports: HarnessReport[] | null;
  /** harness id → 该工具下已有多少条（按当前技能池算） */
  counts: Record<string, number>;
  /** 技能池总数 */
  total: number;
  /** 一个工具都没接入的条数 */
  unassigned: number;
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const { t } = useTranslation();
  const rows = (reports ?? []).filter((r) => r.supportsSkills);

  const row = (key: string, icon: ReactNode, label: string, count: number, active: boolean) => (
    <button
      key={key}
      type="button"
      aria-pressed={active}
      onClick={() => onChange(active ? null : key === "__all" ? null : key)}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] outline-none transition-colors",
        active ? "bg-primary-soft text-primary" : "text-ink-2 hover:bg-surface-2 hover:text-foreground",
      )}
    >
      <span className="grid size-3.5 shrink-0 place-items-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <span className={cn("font-mono text-[9.5px] tabular-nums", active ? "text-primary/70" : "text-ink-3")}>{count}</span>
    </button>
  );

  return (
    <section className="mt-2 rounded-xl border border-border bg-card/60">
      <header className="flex h-7 items-center gap-1.5 border-b border-border/60 px-2.5">
        <Wrench className="size-3 text-ink-3" />
        <span className="text-[11px] font-semibold text-ink-2">{t("skills.toolsTitle")}</span>
        {value ? (
          <button
            type="button"
            title={t("skills.toolsClear")}
            onClick={() => onChange(null)}
            className="ml-auto rounded p-0.5 text-ink-3 outline-none hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        ) : null}
      </header>
      <div className="flex flex-col gap-px p-1.5">
        {row("__all", <Wrench className="size-3" />, t("skills.toolsAll"), total, value === null)}
        {reports === null ? (
          <div className="px-1.5 py-1 text-[10.5px] text-ink-3">{t("common.loading")}</div>
        ) : (
          rows.map((r) => row(r.id, <HarnessIcon id={r.id} className="size-3.5" />, r.name, counts[r.id] ?? 0, value === r.id))
        )}
        {row("__none", <CircleSlash className="size-3" />, t("skills.toolsNone"), unassigned, value === "__none")}
      </div>
    </section>
  );
}
