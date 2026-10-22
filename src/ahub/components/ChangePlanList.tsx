import { AlertTriangle, ArrowRight, FilePlus2, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChangeAction } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

/** 一个值：空值显示为「未设置」，否则用等宽字体展示。 */
function Value({ value, tone }: { value: string; tone: "current" | "next" }) {
  const { t } = useTranslation();
  if (!value) {
    return (
      <span className="text-[11px] italic text-ink-3">{t("envCenter.mirrorNotSet")}</span>
    );
  }
  return (
    <span
      className={cn(
        "break-all font-mono text-[11px]",
        tone === "next" ? "font-medium text-primary" : "text-ink-2",
      )}
    >
      {value}
    </span>
  );
}

/**
 * 变更计划可视化列表：迁移与镜像写入共用。
 *
 * 展示「改哪个文件、改哪一项、原值、新值」，让用户在确认前就能看到全部影响面。
 */
export function ChangePlanList({
  actions,
  warnings,
}: {
  actions: ChangeAction[];
  warnings: string[];
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3">
      {warnings.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-md bg-warning/10 px-2.5 py-2">
          <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-warning">
            <AlertTriangle className="size-2.5" />
            {t("envCenter.mirrorWarnings")}
          </span>
          {warnings.map((w) => (
            <span key={w} className="text-[10px] leading-relaxed text-warning">
              {w}
            </span>
          ))}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border">
        {actions.map((a, i) => {
          const unchanged = a.current && a.current === a.next;
          return (
            <div
              key={`${a.tool}-${a.target}`}
              className={cn("flex flex-col gap-1.5 px-3 py-2.5", i > 0 && "border-t border-border")}
            >
              {/* 第一行：工具名 + 配置项 */}
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium text-foreground">{a.tool}</span>
                <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-2">
                  {a.target}
                </span>
                {a.createsFile ? (
                  <span className="flex items-center gap-0.5 rounded bg-info/15 px-1.5 py-0.5 text-[9px] text-info">
                    <FilePlus2 className="size-2.5" />
                    {t("envCenter.mirrorCreatesFile")}
                  </span>
                ) : null}
                {unchanged ? (
                  <span className="rounded bg-success/15 px-1.5 py-0.5 text-[9px] text-success">
                    {t("envCenter.mirrorNoChange")}
                  </span>
                ) : null}
              </div>

              {/* 第二行：原值 → 新值 */}
              <div className="flex flex-wrap items-center gap-1.5 pl-0.5">
                <Value value={a.current} tone="current" />
                <ArrowRight className="size-3 shrink-0 text-ink-3" />
                <Value value={a.next} tone="next" />
              </div>

              {/* 第三行：文件路径 */}
              <div className="flex items-start gap-1">
                <FileText className="mt-px size-2.5 shrink-0 text-ink-3" />
                <span className="break-all font-mono text-[10px] text-ink-3" dir="ltr">
                  {a.file}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
