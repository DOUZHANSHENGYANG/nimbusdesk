import { AlertTriangle, BookOpen, Check, Copy, Loader2, Terminal } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { copyText } from "@/ahub/lib/api";
import type { CliExplain } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

/** 一条示例命令：说明在上、命令在下，命令可一键复制。 */
function ExampleRow({ description, command }: { description: string; command: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const ok = await copyText(command);
    if (ok) {
      setCopied(true);
      toast.success(t("common.copied"));
      window.setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <div className="group flex flex-col gap-1 rounded-md border border-border bg-bg-subtle px-2.5 py-2">
      {description ? (
        <span className="text-[11px] leading-relaxed text-ink-2">{description}</span>
      ) : null}
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-foreground">
          {command}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          title={t("envCenter.copyCommand")}
          aria-label={t("envCenter.copyCommand")}
          className="shrink-0 rounded p-1 text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copied ? <Check className="size-3" strokeWidth={3} /> : <Copy className="size-3" />}
        </button>
      </div>
    </div>
  );
}

/** 一行「标签：值」，值可换行（长路径不撑破布局）。 */
function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{label}</span>
      <span
        className={cn("break-all text-[11px] leading-relaxed text-ink-2", mono && "font-mono")}
        dir="ltr"
      >
        {value}
      </span>
    </div>
  );
}

export function CliExplainPanel({
  explain,
  loading,
  hasTldr,
}: {
  explain: CliExplain | null;
  loading: boolean;
  hasTldr: boolean;
}) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-[11px] text-ink-3">
        <Loader2 className="size-3.5 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  if (!explain) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
        <div className="grid size-11 place-items-center rounded-xl border border-border bg-surface text-ink-3">
          <BookOpen className="size-5" />
        </div>
        <div className="text-[12px] font-medium text-foreground">{t("envCenter.detailPick")}</div>
        <div className="max-w-xs text-[11px] leading-relaxed text-ink-3">
          {t("envCenter.detailPickHint")}
        </div>
      </div>
    );
  }

  // 兜底模式：tldr 未收录或尚未下载，用途来自 --help 探测
  const fallback = explain.source === "probe";

  return (
    <div className="flex flex-col gap-4">
      {/* 标题行 */}
      <div className="flex flex-wrap items-center gap-2">
        <Terminal className="size-4 shrink-0 text-ink-3" />
        <span className="text-[15px] font-semibold text-foreground">{explain.name}</span>
        {explain.version ? (
          <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-2">
            {explain.version}
          </span>
        ) : (
          <span className="text-[10px] text-ink-3">{t("envCenter.noVersion")}</span>
        )}
        {explain.timedOut ? (
          <span className="flex items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
            <AlertTriangle className="size-2.5" />
            {t("envCenter.timedOut")}
          </span>
        ) : null}
        {explain.source === "tldr-zh" || explain.source === "tldr-en" ? (
          <span className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] text-success">
            tldr
          </span>
        ) : null}
      </div>

      {/* 一句话用途 */}
      {explain.description ? (
        <p className="text-[12px] leading-relaxed text-ink-2">{explain.description}</p>
      ) : (
        <p className="text-[11px] leading-relaxed text-ink-3">{t("envCenter.noExamples")}</p>
      )}

      {/* 兜底模式提示 */}
      {fallback ? (
        <div className="rounded-md bg-warning/10 px-2.5 py-2 text-[10px] leading-relaxed text-warning">
          {hasTldr ? t("envCenter.tldrFallback") : t("envCenter.tldrOfflineHint")}
        </div>
      ) : null}

      {/* 超时说明 */}
      {explain.timedOut && !explain.description ? (
        <div className="rounded-md bg-warning/10 px-2.5 py-2 text-[10px] leading-relaxed text-warning">
          {t("envCenter.timedOutHint")}
        </div>
      ) : null}

      {/* 常用示例 */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
          {t("envCenter.examples")}
        </span>
        {explain.examples.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {explain.examples.map((ex, i) => (
              <ExampleRow key={`${ex.command}-${i}`} description={ex.description} command={ex.command} />
            ))}
          </div>
        ) : (
          <span className="text-[11px] text-ink-3">{t("envCenter.noExamples")}</span>
        )}
      </div>

      {/* 元信息：来源、安装路径、说明 */}
      <div className="flex flex-col gap-2.5 border-t border-border pt-3">
        <MetaRow label={t("envCenter.source")} value={explainSourceLabel(explain.source, t)} />
        <MetaRow label={t("envCenter.installPath")} value={explain.installPath} mono />
        {explain.note ? <MetaRow label={t("envCenter.probeNote")} value={explain.note} /> : null}
      </div>
    </div>
  );
}

/// 把后端返回的来源标识转成用户可读的文案。
function explainSourceLabel(source: string, t: (k: string) => string): string {
  if (source === "tldr-zh") return t("envCenter.sourceTldrZh");
  if (source === "tldr-en") return t("envCenter.sourceTldrEn");
  if (source === "probe") return t("envCenter.sourceProbe");
  return t("envCenter.sourceUnknown");
}
