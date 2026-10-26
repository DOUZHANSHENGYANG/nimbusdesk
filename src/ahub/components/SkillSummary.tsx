import { ChevronDown, Sparkles } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/ahub/components/ui/badge";
import type { SkillSummary } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

/** 定性 → i18n key（避免动态拼 key，i18n 才能被静态检查） */
const KIND_KEY: Record<string, string> = {
  tool: "skillSummary.kindTool",
  reference: "skillSummary.kindReference",
  workflow: "skillSummary.kindWorkflow",
  knowledge: "skillSummary.kindKnowledge",
};

function fmtTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * 技能 AI 摘要区（skills-summary）：
 * 默认折叠，只显示一行「领域 · 定性 · 一句话描述」；点击展开显示完整信息与规模统计。
 * 只负责展示 —— 「生成摘要」入口在管理页签的工具栏（暂存左侧），不在这个面板上。
 */
export function SkillSummaryPanel({
  summary,
  className,
}: {
  summary: SkillSummary | null | undefined;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const kindLabel = (kind: string) => t(KIND_KEY[kind] ?? "skillSummary.kindTool");

  return (
    <div className={cn("shrink-0 rounded-xl border border-border bg-card", className)}>
      <div className="flex items-center gap-2 px-3 py-2">
        <Sparkles className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-ink-3">
          {t("skillSummary.title")}
        </span>
      </div>

      {summary ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={t(open ? "skillSummary.collapse" : "skillSummary.expand")}
          className="flex w-full items-start gap-1.5 border-t border-border px-3 py-2 text-left outline-none transition-colors hover:bg-surface-2"
        >
          <div className="min-w-0 flex-1">
            {/* 折叠态：一行「领域 · 定性 · 一句话描述」。栏宽只有 320px，
                描述按剩余宽度截断，完整内容在展开态与 tooltip 里 */}
            <div
              className="flex min-w-0 items-center gap-1.5"
              title={`${summary.domain} · ${kindLabel(summary.kind)} · ${summary.oneLiner}`}
            >
              <span className="shrink-0 rounded-md bg-primary-soft px-1.5 py-0.5 text-[11px] font-medium text-primary">
                {summary.domain}
              </span>
              <span className="shrink-0 text-[11px] text-ink-3">·</span>
              <span className="shrink-0 text-[11px] text-ink-3">{kindLabel(summary.kind)}</span>
              <span className="shrink-0 text-[11px] text-ink-3">·</span>
              <span className="min-w-0 flex-1 truncate text-xs text-ink-2">{summary.oneLiner}</span>
            </div>
          </div>
          <ChevronDown
            className={cn("mt-0.5 size-3.5 shrink-0 text-ink-3 transition-transform", open && "rotate-180")}
          />
        </button>
      ) : (
        <div className="border-t border-border px-3 py-2 text-[11px] text-ink-3">{t("skillSummary.empty")}</div>
      )}

      {summary && open ? (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-2.5">
          {/* 右栏只有 320px 宽：领域与定性并排，其余独占一行 */}
          <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-wider text-ink-3">
                {t("skillSummary.domain")}
              </div>
              <div className="mt-0.5 text-xs text-foreground">{summary.domain}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-wider text-ink-3">
                {t("skillSummary.kind")}
              </div>
              <div className="mt-0.5">
                <Badge variant="muted">{kindLabel(summary.kind)}</Badge>
              </div>
            </div>
          </div>
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wider text-ink-3">
              {t("skillSummary.oneLiner")}
            </div>
            <div className="mt-0.5 text-xs leading-relaxed text-foreground">{summary.oneLiner}</div>
          </div>
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wider text-ink-3">
              {t("skillSummary.scale")}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">{t("skillSummary.scripts", { n: summary.scriptCount })}</Badge>
              <Badge variant="outline">{t("skillSummary.references", { n: summary.referenceCount })}</Badge>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-2 text-[10px] text-ink-3">
            <span>{t("skillSummary.generatedAt", { at: fmtTime(summary.generatedAt) })}</span>
            {summary.model ? <span className="font-mono">{summary.model}</span> : null}
            <span>{t("skillSummary.staleHint")}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
