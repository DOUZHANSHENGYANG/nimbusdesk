import { Check, CircleAlert, Eye, EyeOff, Loader2, ShieldAlert, ShieldCheck, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/ahub/components/ui/badge";
import { Button } from "@/ahub/components/ui/button";
import { Textarea } from "@/ahub/components/ui/input";
import { api } from "@/ahub/lib/api";
import type { VetReportRow } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

/** SSEP 规则 id → 人话 i18n key */
const RULE_KEY: Record<string, string> = {
  "R01-destructive": "vetRuleR01",
  "R02-exec-download": "vetRuleR02",
  "R03-dynamic-exec": "vetRuleR03",
  "R04-system-write": "vetRuleR04",
  "R05-secrets": "vetRuleR05",
  "R06-obfuscation": "vetRuleR06",
  "R07-env-harvest": "vetRuleR07",
  "R08-cred-files": "vetRuleR08",
  "SSEP-STALE": "vetRuleStale",
};

/**
 * 严重程度 → 徽标配色。四档都上色，别让人靠读字分辨：
 * 严重=红、高危=琥珀、中危=蓝、低危=灰。配色走 Badge 的 variant，颜色仍只由 token 决定。
 */
function sevMeta(sev: string) {
  if (sev === "critical") return { variant: "danger" as const, key: "sevCritical" };
  if (sev === "high") return { variant: "warning" as const, key: "sevHigh" };
  if (sev === "low") return { variant: "muted" as const, key: "sevLow" };
  return { variant: "info" as const, key: "sevMedium" };
}

/**
 * 人工复审界面：加载某技能的审查报告，逐条发现可忽略/恢复，
 * 并给出整体复核结论（批准 / 驳回）。所有处置写入 .hub.json 并留 lifecycle 事件。
 */
export function VetReviewPanel({
  dirName,
  onChanged,
  className,
}: {
  dirName: string;
  /** 复审状态变化后通知外部刷新（列表徽章等） */
  onChanged?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [report, setReport] = useState<VetReportRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string>("");
  const [note, setNote] = useState("");
  const [showIgnored, setShowIgnored] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.readVetReport(dirName);
      setReport(r);
      setNote(r?.reviewNote ?? "");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, [dirName]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (rule: string, file: string, line: number, ignored: boolean) => {
    const key = `${rule}|${file}|${line}`;
    setBusyKey(key);
    try {
      await api.reviewVetFinding(dirName, rule, file, line, ignored);
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusyKey("");
    }
  };

  const ignoreAll = async () => {
    setBusyKey("__all__");
    try {
      const n = await api.ignoreAllVetFindings(dirName);
      toast.success(t("skills.reviewIgnoredAll", { n }));
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusyKey("");
    }
  };

  const setVerdict = async (verdict: string) => {
    setBusyKey("__verdict__");
    try {
      await api.setVetReview(dirName, verdict, note);
      toast.success(verdict === "approved" ? t("skills.reviewApproved") : verdict === "rejected" ? t("skills.reviewRejected") : t("skills.reviewCleared"));
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusyKey("");
    }
  };

  if (loading) {
    return (
      <div className={cn("grid place-items-center py-16 text-xs text-ink-3", className)}>
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  if (!report) {
    return (
      <div className={cn("flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-4 py-14 text-center", className)}>
        <ShieldAlert className="size-6 text-ink-3" />
        <div>
          <p className="text-xs text-ink-2">{t("skills.reviewNoReport")}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-3">{t("skills.reviewNoReportHint")}</p>
        </div>
      </div>
    );
  }

  const pending = report.findings.filter((f) => !f.ignored);
  const ignoredList = report.findings.filter((f) => f.ignored);
  const canApprove = pending.length === 0;

  const verdictTone =
    report.review === "approved"
      ? "text-success"
      : report.review === "rejected"
        ? "text-danger"
        : report.verdict === "REJECT"
          ? "text-danger"
          : report.verdict === "REVIEW"
            ? "text-warning"
            : "text-success";

  const verdictLabel =
    report.review === "approved"
      ? t("skills.reviewApprovedTag")
      : report.review === "rejected"
        ? t("skills.reviewRejectedTag")
        : report.verdict === "REJECT"
          ? t("skills.vetReject")
          : report.verdict === "REVIEW"
            ? t("skills.vetReview")
            : t("skills.vetPass");

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* ── 结论概览 ── */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className={cn("grid size-10 shrink-0 place-items-center rounded-lg", verdictTone, "bg-current/10")}>
              <ShieldCheck className="size-5" />
            </span>
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-wider text-ink-3">{t("skills.reviewVerdict")}</div>
              <div className={cn("text-sm font-semibold", verdictTone)}>{verdictLabel}</div>
              <div className="mt-0.5 text-[11px] text-ink-3">
                {t("skills.reviewCheckedAt", { at: report.checkedAt ? report.checkedAt.slice(0, 19).replace("T", " ") : "—" })}
                {report.checkedBy ? ` · ${report.checkedBy}` : ""}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 text-[11px]">
            <span className="rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1 font-medium text-danger">
              {t("skills.sevCritical")} {report.critical}
            </span>
            <span className="rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1 font-medium text-warning">
              {t("skills.sevHigh")} {report.high}
            </span>
            <span className="rounded-lg border border-border bg-bg-subtle px-2.5 py-1 font-medium text-ink-2">
              {t("skills.sevMedium")} {report.medium}
            </span>
          </div>
        </div>

        {report.review ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2">
            <Check className={cn("mt-0.5 size-3.5 shrink-0", report.review === "approved" ? "text-success" : "text-danger")} />
            <span className="min-w-0 text-[11px] leading-relaxed text-ink-2">
              {t("skills.reviewedAt", { at: report.reviewedAt ? report.reviewedAt.slice(0, 19).replace("T", " ") : "—" })}
              {report.reviewNote ? ` · ${report.reviewNote}` : ""}
            </span>
          </div>
        ) : null}
      </div>

      {/* ── 待复核问题 ── */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <CircleAlert className={cn("size-3.5 shrink-0", pending.length ? "text-warning" : "text-success")} />
          <h3 className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
            {t("skills.reviewFindings")}
            <span className="ml-1.5 tabular-nums">
              {pending.length} / {report.findings.length}
            </span>
          </h3>
          {pending.length > 0 ? (
            <Button size="sm" variant="secondary" className="h-7 text-[11px]" disabled={busyKey === "__all__"} onClick={() => void ignoreAll()}>
              {busyKey === "__all__" ? <Loader2 className="animate-spin" /> : <EyeOff />}
              {t("skills.reviewIgnoreAll")}
            </Button>
          ) : null}
          {ignoredList.length > 0 ? (
            <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setShowIgnored((v) => !v)}>
              {showIgnored ? <EyeOff /> : <Eye />}
              {showIgnored ? t("skills.reviewHideIgnored") : t("skills.reviewShowIgnored", { n: ignoredList.length })}
            </Button>
          ) : null}
        </div>

        {report.findings.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-ink-3">{t("skills.reviewNoFindings")}</p>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {[...pending, ...(showIgnored ? ignoredList : [])].map((f) => {
              const meta = sevMeta(f.severity);
              const key = `${f.rule}|${f.file}|${f.line}`;
              const isBusy = busyKey === key;
              return (
                <div key={key} className={cn("px-4 py-3", f.ignored && "opacity-55")}>
                  <div className="flex items-start gap-2.5">
                    <Badge variant={meta.variant} className="mt-0.5 shrink-0">
                      {t(`skills.${meta.key}`)}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-xs font-medium text-foreground">
                          {RULE_KEY[f.rule] ? t(`skills.${RULE_KEY[f.rule]}`) : f.rule}
                        </span>
                        {f.ignored ? (
                          <Badge variant="muted">
                            <Check />
                            {t("skills.reviewIgnoredTag")}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 break-all font-mono text-[11px] text-ink-3" dir="ltr">
                        {f.file}
                        {f.line > 0 ? `:${f.line}` : ""}
                      </p>
                      {f.excerpt ? (
                        <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-ink-2" dir="ltr">
                          {f.excerpt}
                        </pre>
                      ) : null}
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 shrink-0 text-[11px]"
                      disabled={isBusy}
                      onClick={() => void toggle(f.rule, f.file, f.line, !f.ignored)}
                    >
                      {isBusy ? <Loader2 className="animate-spin" /> : f.ignored ? <Undo2 /> : <EyeOff />}
                      {f.ignored ? t("skills.reviewRestore") : t("skills.reviewIgnore")}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── 复核结论 ── */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{t("skills.reviewConclusion")}</div>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-3">{t("skills.reviewConclusionHint")}</p>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("skills.reviewNotePh")}
          className="mt-2 min-h-16 resize-y text-xs"
        />
        {/* 结论按钮走右边（习惯性位置），左边留给「还差什么才能批准」的提示 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="me-auto text-[11px] text-ink-3">{canApprove ? "" : t("skills.reviewApproveBlocked")}</span>
          <Button
            size="sm"
            className="h-8"
            disabled={!canApprove || busyKey === "__verdict__"}
            title={canApprove ? undefined : t("skills.reviewApproveBlocked")}
            onClick={() => void setVerdict("approved")}
          >
            {busyKey === "__verdict__" ? <Loader2 className="animate-spin" /> : <ShieldCheck className="size-3.5" />}
            {t("skills.reviewApprove")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-8 text-danger hover:bg-danger/10 hover:text-danger"
            disabled={busyKey === "__verdict__"}
            onClick={() => void setVerdict("rejected")}
          >
            <ShieldAlert className="size-3.5" />
            {t("skills.reviewReject")}
          </Button>
          {report.review ? (
            <Button size="sm" variant="ghost" className="h-8 text-[11px]" disabled={busyKey === "__verdict__"} onClick={() => void setVerdict("")}>
              <Undo2 className="size-3.5" />
              {t("skills.reviewClear")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
