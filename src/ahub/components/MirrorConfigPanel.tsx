import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ChangePlanList } from "@/ahub/components/ChangePlanList";
import { Button } from "@/ahub/components/ui/button";
import { api } from "@/ahub/lib/api";
import type { ApplyOutcome, ChangePlan, MirrorTool, TldrStatus } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

/** 一个工具一行：勾选 + 名称 + 当前/推荐值 + 回滚。 */
function MirrorRow({
  tool,
  checked,
  onToggle,
  busy,
  onRollback,
}: {
  tool: MirrorTool;
  checked: boolean;
  onToggle: () => void;
  busy: boolean;
  onRollback: () => void;
}) {
  const { t } = useTranslation();
  const upToDate = tool.current && tool.current === tool.recommended;
  // 配置文件不存在时仍可写入（会创建），只有「不可写」才禁用
  const selectable = tool.writable && !busy;

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          disabled={!selectable}
          onClick={onToggle}
          aria-label={tool.name}
          className={cn(
            "grid size-4 shrink-0 place-items-center rounded border transition-colors",
            !selectable
              ? "cursor-default border-border/60"
              : checked
                ? "border-primary bg-primary text-white"
                : "border-border-strong hover:border-primary",
          )}
        >
          {checked ? <Check className="size-3" strokeWidth={3} /> : null}
        </button>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-medium text-foreground">{tool.name}</span>
            {upToDate ? (
              <span className="flex shrink-0 items-center gap-0.5 rounded bg-success/15 px-1.5 py-0.5 text-[9px] text-success">
                <Check className="size-2.5" strokeWidth={3} />
                {t("envCenter.mirrorRecommended")}
              </span>
            ) : null}
            {!tool.installed ? (
              <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[9px] text-ink-3">
                {t("envCenter.notInstalled")}
              </span>
            ) : null}
            {!tool.writable ? (
              <span className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-[9px] text-warning">
                {t("envCenter.mirrorUnwritable")}
              </span>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-mono text-[10px] text-ink-2" dir="ltr">
              {tool.current || t("envCenter.mirrorNotSet")}
            </span>
            <span className="truncate font-mono text-[10px] text-ink-3" dir="ltr">
              → {tool.recommended}
            </span>
          </div>
        </div>

        {tool.backup ? (
          <button
            type="button"
            disabled={busy}
            onClick={onRollback}
            title={t("envCenter.mirrorRollback")}
            aria-label={t("envCenter.mirrorRollback")}
            className="shrink-0 rounded p-1.5 text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <RotateCcw className="size-3.5" />
          </button>
        ) : null}
      </div>

      {/* 文件路径与不可写原因 */}
      <div className="flex flex-col gap-0.5 pl-[1.6rem]">
        <span className="break-all font-mono text-[10px] text-ink-3" dir="ltr">
          {tool.path || "—"}
        </span>
        {tool.note ? (
          <span className="text-[10px] leading-relaxed text-warning">{tool.note}</span>
        ) : null}
        {tool.backup ? (
          <span className="break-all text-[10px] text-ink-3" dir="ltr">
            {t("envCenter.mirrorBackupAt", { path: tool.backup })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** 单个工具的写入结果。 */
function OutcomeRow({ outcome }: { outcome: ApplyOutcome }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-0.5 rounded-md bg-bg-subtle px-2.5 py-1.5">
      <div className="flex items-center gap-1.5">
        {outcome.ok ? (
          <Check className="size-3 shrink-0 text-success" strokeWidth={3} />
        ) : (
          <X className="size-3 shrink-0 text-danger" strokeWidth={3} />
        )}
        <span className="text-[11px] font-medium text-foreground">{outcome.tool}</span>
        {outcome.verified ? (
          <span className="text-[9px] text-success">{t("envCenter.mirrorVerified")}</span>
        ) : outcome.ok ? null : (
          <span className="text-[9px] text-danger">{t("envCenter.mirrorUnverified")}</span>
        )}
      </div>
      <span className="break-all text-[10px] leading-relaxed text-ink-2" dir="ltr">
        {outcome.message}
      </span>
    </div>
  );
}

export function MirrorConfigPanel() {
  const { t } = useTranslation();
  const [tools, setTools] = useState<MirrorTool[]>([]);
  // 已安装的排前面，便于先处理已装工具的镜像
  const sortedTools = [...tools].sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const [tldr, setTldr] = useState<TldrStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<ChangePlan | null>(null);
  const [outcomes, setOutcomes] = useState<ApplyOutcome[]>([]);
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [tldrBusy, setTldrBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, status] = await Promise.all([
        api.mirrorList(),
        api.cliTldrStatus().catch(() => null),
      ]);
      setTools(list);
      setTldr(status);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: string) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // 选择变了，旧预览就作废，避免「预览 A、写入 B」
    setPlan(null);
    setOutcomes([]);
  };

  const doPreview = async () => {
    if (sel.size === 0) {
      toast.info(t("envCenter.mirrorNothingSelected"));
      return;
    }
    setPlanning(true);
    setOutcomes([]);
    try {
      setPlan(await api.mirrorPlan([...sel]));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setPlanning(false);
    }
  };

  const doApply = async () => {
    if (sel.size === 0) {
      toast.info(t("envCenter.mirrorNothingSelected"));
      return;
    }
    setApplying(true);
    try {
      const res = await api.mirrorApply([...sel]);
      setOutcomes(res);
      const okN = res.filter((r) => r.ok).length;
      if (okN > 0) toast.success(t("envCenter.mirrorApplied", { ok: okN, total: res.length }));
      // 失败项逐条报出原因，不掩盖
      for (const r of res.filter((x) => !x.ok)) {
        toast.error(`${r.tool}: ${r.message}`);
      }
      setPlan(null);
      await load();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setApplying(false);
    }
  };

  const doRollback = async (id: string) => {
    setRollingBack(id);
    try {
      const msg = await api.mirrorRollback(id);
      toast.success(msg);
      await load();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setRollingBack(null);
    }
  };

  const doTldrEnsure = async () => {
    setTldrBusy(true);
    try {
      const status = await api.cliTldrEnsure();
      setTldr(status);
      toast.success(t("envCenter.tldrDownloaded"));
    } catch (e) {
      // 下载失败不是致命错误：会退到 --help 兜底
      toast.error(String(e));
    } finally {
      setTldrBusy(false);
    }
  };

  const doTldrClear = async () => {
    setTldrBusy(true);
    try {
      await api.cliTldrClear();
      setTldr(await api.cliTldrStatus());
      toast.success(t("envCenter.tldrCleared"));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setTldrBusy(false);
    }
  };

  const busy = planning || applying || rollingBack !== null;
  const langs = tldr?.languages?.join(", ") ?? "";

  return (
    <div className="flex max-h-[480px] flex-col gap-3 overflow-y-auto">
      {/* 顶部操作条：位置恒常，按钮始终在右侧 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto min-w-0 text-[11px] leading-relaxed text-ink-3">
          {t("envCenter.mirrorHint")}
        </span>
        <Button
          size="sm"
          variant="secondary"
          className="h-8 text-[11px]"
          disabled={busy || sel.size === 0}
          onClick={() => void doPreview()}
        >
          {planning ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          {t("envCenter.mirrorPreview")}
        </Button>
        <Button
          size="sm"
          className="h-8 text-[11px]"
          disabled={busy || sel.size === 0}
          onClick={() => void doApply()}
        >
          {applying ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {applying ? t("envCenter.mirrorApplying") : t("envCenter.mirrorApply")}
        </Button>
      </div>

      {/* tldr 缓存状态：与镜像无关，但同属「网络来源」这一类 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2">
        <span className="text-[11px] font-medium text-ink-2">{t("envCenter.tldrStatus")}</span>
        {tldr?.ready ? (
          <span className="flex items-center gap-1 text-[11px] text-success">
            <Check className="size-3" strokeWidth={3} />
            {t("envCenter.tldrReady", { langs })}
          </span>
        ) : (
          <span className="text-[11px] text-ink-3">{t("envCenter.tldrMissing")}</span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            className="h-7 text-[11px]"
            disabled={tldrBusy}
            onClick={() => void doTldrEnsure()}
          >
            {tldrBusy ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Download className="size-3" />
            )}
            {tldrBusy ? t("envCenter.tldrDownloading") : t("envCenter.tldrDownload")}
          </Button>
          {tldr?.ready ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[11px]"
              disabled={tldrBusy}
              onClick={() => void doTldrClear()}
            >
              <Trash2 className="size-3" />
              {t("envCenter.tldrClear")}
            </Button>
          ) : null}
        </div>
      </div>

      {/* 工具列表 */}
      {loading ? (
        <div className="flex items-center gap-2 py-6 text-xs text-ink-3">
          <Loader2 className="size-3.5 animate-spin" />
          {t("common.loading")}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          {sortedTools.map((tool, i) => (
            <div key={tool.id} className={cn(i > 0 && "border-t border-border")}>
              <MirrorRow
                tool={tool}
                checked={sel.has(tool.id)}
                onToggle={() => toggle(tool.id)}
                busy={busy || rollingBack === tool.id}
                onRollback={() => void doRollback(tool.id)}
              />
            </div>
          ))}
          {tools.length === 0 ? (
            <div className="px-3 py-6 text-xs text-ink-3">{t("common.empty")}</div>
          ) : null}
        </div>
      )}

      {/* 预览 */}
      {plan ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-semibold text-foreground">
              {t("envCenter.mirrorPlanTitle")}
            </span>
            <span className="text-[10px] leading-relaxed text-ink-3">
              {t("envCenter.mirrorPlanHint")}
            </span>
          </div>
          <ChangePlanList actions={plan.actions} warnings={plan.warnings} />
        </div>
      ) : null}

      {/* 写入结果 */}
      {outcomes.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {outcomes.map((o) => (
            <OutcomeRow key={`${o.tool}-${o.message}`} outcome={o} />
          ))}
        </div>
      ) : null}

      {/* 安全说明：与项目其它破坏性操作保持同样的告知方式 */}
      <div className="flex items-start gap-1.5 text-[10px] leading-relaxed text-ink-3">
        <AlertTriangle className="mt-px size-3 shrink-0" />
        <span>{t("envCenter.mirrorPlanHint")}</span>
      </div>
    </div>
  );
}
