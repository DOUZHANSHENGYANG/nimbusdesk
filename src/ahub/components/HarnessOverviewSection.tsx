import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HarnessIcon } from "@/ahub/components/HarnessIcon";
import { Button } from "@/ahub/components/ui/button";
import { api } from "@/ahub/lib/api";
import { dirBase } from "@/ahub/lib/skillHarness";
import type { HarnessReport } from "@/ahub/lib/types";
import { useData } from "@/ahub/stores/data";

/**
 * 本机工具总览：一屏看到每个 harness 里有多少技能副本、多少 MCP、哪些技能副本落后于中枢。
 *
 * 技能页只服务自己的池子，MCP 页只服务 MCP；这个表回答的是「本机这些工具里到底有什么」。
 * 具体操作仍在下面「本机技能」和 MCP 页的工具维度里，这里不重复做破坏性按钮。
 */
export function HarnessOverviewSection() {
  const { t } = useTranslation();
  const skills = useData((s) => s.skills);
  const [reports, setReports] = useState<HarnessReport[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      setReports(await api.scanHarnesses());
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const hub = useMemo(() => new Map(skills.map((skill) => [skill.dirName.toLowerCase(), skill])), [skills]);
  const tools = useMemo(
    () => (reports ?? []).filter((report) => report.supportsSkills || report.supportsMcp),
    [reports],
  );
  const totalSkills = useMemo(() => tools.reduce((sum, report) => sum + (report.skills?.length ?? 0), 0), [tools]);
  const totalMcp = useMemo(() => tools.reduce((sum, report) => sum + (report.mcpServers?.length ?? 0), 0), [tools]);

  /** 工具目录里的 SKILL.md 比中枢里的 updatedAt 旧 → 提示可以覆盖更新。留 1 分钟容差。 */
  const outdated = (report: HarnessReport) =>
    (report.skills ?? []).filter((detected) => {
      const meta = hub.get(dirBase(detected.path).toLowerCase());
      if (!meta?.updatedAt || detected.updatedAt <= 0) return false;
      const hubAt = new Date(meta.updatedAt).getTime();
      return Number.isFinite(hubAt) && hubAt > detected.updatedAt + 60_000;
    }).length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-3">
          {t("harnessOverview.summary", { tools: tools.length, skills: totalSkills, mcp: totalMcp })}
        </span>
        <Button size="sm" variant="secondary" className="ml-auto h-7 text-[11px]" disabled={busy} onClick={() => void load()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          {t("harnessOverview.refresh")}
        </Button>
      </div>

      {reports === null ? (
        <div className="py-6 text-center text-xs text-ink-3">{t("common.loading")}</div>
      ) : tools.length === 0 ? (
        <div className="py-6 text-center text-xs text-ink-3">{t("harnessOverview.empty")}</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <div className="min-w-[520px]">
            <div className="grid grid-cols-[minmax(0,1fr)_80px_80px_90px_78px] gap-2 border-b border-border bg-surface-2 px-3 py-1.5 text-[10.5px] text-ink-3">
              <span>{t("harnessOverview.colTool")}</span>
              <span className="text-right">{t("harnessOverview.colSkills")}</span>
              <span className="text-right">{t("harnessOverview.colMcp")}</span>
              <span className="text-right">{t("harnessOverview.colOutdated")}</span>
              <span className="text-right">{t("harnessOverview.colStatus")}</span>
            </div>
            {tools.map((report) => {
              const stale = outdated(report);
              return (
                <div
                  key={report.id}
                  className="grid grid-cols-[minmax(0,1fr)_80px_80px_90px_78px] items-center gap-2 border-b border-border/60 px-3 py-2 text-[11.5px] last:border-0"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <HarnessIcon id={report.id} className="size-4 shrink-0" />
                    <span className="truncate text-foreground">{report.name}</span>
                  </span>
                  <span className="text-right font-mono tabular-nums text-ink-2">
                    {report.supportsSkills ? (report.skills?.length ?? 0) : "—"}
                  </span>
                  <span className="text-right font-mono tabular-nums text-ink-2">
                    {report.supportsMcp ? (report.mcpServers?.length ?? 0) : "—"}
                  </span>
                  <span className="text-right">
                    {stale > 0 ? (
                      <span
                        className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning"
                        title={t("harnessOverview.outdatedHint")}
                      >
                        {t("harnessOverview.outdated", { n: stale })}
                      </span>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </span>
                  <span className="text-right">
                    <span
                      className={
                        report.exists
                          ? "rounded-full bg-success/12 px-1.5 py-0.5 text-[10px] text-success"
                          : "rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-ink-3"
                      }
                    >
                      {t(report.exists ? "harnessOverview.installed" : "harnessOverview.missing")}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
