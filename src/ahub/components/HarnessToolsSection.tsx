import { Copy, FileCode, FolderOpen, Loader2, RefreshCw, Save, Terminal, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfigEditorPanel } from "@/ahub/components/ConfigEditorPanel";
import { HarnessIcon } from "@/ahub/components/HarnessIcon";
import { Button } from "@/ahub/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/ahub/components/ui/dialog";
import { api, copyText } from "@/ahub/lib/api";
import { loadHarnessReports, writeHarnessScan } from "@/ahub/lib/harnessScan";
import { sortByOrder } from "@/ahub/lib/harnessOrder";
import { useSettings } from "@/ahub/stores/settings";

/** 稳定的空数组引用：没配过顺序时给 selector 用，避免每次返回新数组 */
const NO_ORDER: string[] = [];
import type { HarnessReport, ToolVersion } from "@/ahub/lib/types";

/** 官方支持用它把整个配置/数据根目录搬到别的盘；没有的只能用目录联接。 */
const MIGRATION_ENV: Record<string, string> = {
  "claude-code": "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  "gemini-cli": "GEMINI_CLI_HOME",
  opencode: "XDG_CONFIG_HOME / XDG_DATA_HOME",
  "pi-agent": "PI_CODING_AGENT_DIR",
  codebuddy: "CODEBUDDY_CONFIG_DIR",
  deepseek: "DSH_HOME",
};


function parentOf(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  const cut = Math.max(clean.lastIndexOf("\\"), clean.lastIndexOf("/"));
  return cut > 0 ? clean.slice(0, cut) : "";
}

function configPaths(report: HarnessReport): string[] {
  if (report.configPaths?.length) return report.configPaths;
  return report.configPath ? report.configPath.split(" · ").filter(Boolean) : [];
}

/**
 * 每个 harness 一张小卡：CLI 状态、配置文件、技能目录、备份与迁移入口都在这里。
 *
 * 这是「按工具分别管理」的面；CLI 批量更新和配置版本历史仍在下面两个更细的区块里。
 */
export function HarnessToolsSection() {
  const { t } = useTranslation();
  const [reports, setReports] = useState<HarnessReport[] | null>(null);
  const [tools, setTools] = useState<ToolVersion[]>([]);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [migration, setMigration] = useState<HarnessReport | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const list = await api.toolList();
      setTools(list?.tools ?? []);
      // 当天已扫过就直接用缓存（共用那一份）；次日首次进入或用户点单卡刷新才重新扫目录。
      setReports(await loadHarnessReports());
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  /** 只刷新一个工具：改了某个工具的配置/技能目录后不必等第二天或重扫全部。 */
  const refreshOne = useCallback(async (report: HarnessReport, announce = true) => {
    setRefreshing(report.id);
    try {
      const next = await api.scanHarness(report.id);
      setReports((prev) => {
        const list = (prev ?? []).map((item) => (item.id === next.id ? next : item));
        writeHarnessScan(list);
        return list;
      });
      if (announce) toast.success(t("harnessTools.refreshOneDone", { name: report.name }));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setRefreshing(null);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const toolMap = useMemo(() => new Map(tools.map((tool) => [tool.id, tool])), [tools]);
  // 卡片顺序跟着用户在「设置 → 工具顺序」里拖出来的那份；没配过就用后端给的默认顺序
  // （opencode / dsh / codex / claude code / codebuddy / pi 在前）。
  const harnessOrder = useSettings((s) => s.info?.settings.harnessOrder ?? NO_ORDER);
  const toolsToShow = useMemo(
    () =>
      sortByOrder(
        (reports ?? []).filter((report) => report.id !== "custom-dirs" && (report.exists || toolMap.get(report.id)?.installed)),
        harnessOrder,
      ) ?? [],
    [reports, toolMap, harnessOrder],
  );

  const copy = (text: string) => {
    void copyText(text).then((ok) => ok && toast.success(t("common.copied")));
  };

  const openFolder = (path: string) => {
    const target = parentOf(path) || path;
    if (target) void api.revealPath(target);
  };

  const backup = async (report: HarnessReport) => {
    setActing(`backup:${report.id}`);
    try {
      const saved = await api.vaultSnapshot([report.id], "manual");
      toast.success(t("harnessTools.backupDone", { n: saved.length }));
      await refreshOne(report, false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setActing(null);
    }
  };

  const updateCli = async (report: HarnessReport) => {
    setActing(`update:${report.id}`);
    try {
      const outcome = await api.toolUpdate([report.id]);
      const failed = outcome.filter((item) => !item.ok);
      if (failed.length) failed.forEach((item) => toast.error(`${item.name}: ${item.message}`));
      else toast.success(t("harnessTools.updateDone", { name: report.name, version: outcome[0]?.to ?? "" }));
      await refreshOne(report, false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setActing(null);
    }
  };

  const checkCli = async () => {
    setChecking(true);
    try {
      const list = await api.toolCheckLatest();
      setTools(list?.tools ?? []);
      const n = list.tools.filter((tool) => tool.hasUpdate).length;
      if (n > 0) toast.success(t("harnessTools.checkDone", { n }));
      else toast.info(t("harnessTools.checkNone"));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setChecking(false);
    }
  };

  const migrationRoot = (report: HarnessReport): string => {
    const skillDir = (report.skillsDirs ?? [])[0];
    if (skillDir) return parentOf(skillDir);
    const cfg = configPaths(report)[0];
    return cfg ? parentOf(cfg) : "";
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-3">{t("harnessTools.hint")}</span>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto h-7 text-[11px]"
          disabled={busy || checking}
          onClick={() => void checkCli()}
        >
          {checking ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          {t("harnessTools.checkCli")}
        </Button>
      </div>

      {reports === null ? (
        <div className="py-6 text-center text-xs text-ink-3">{t("common.loading")}</div>
      ) : toolsToShow.length === 0 ? (
        <div className="py-6 text-center text-xs text-ink-3">{t("harnessTools.empty")}</div>
      ) : (
        <div className="flex flex-col gap-2">
          {toolsToShow.map((report) => {
            const tool = toolMap.get(report.id);
            const paths = configPaths(report);
            const root = migrationRoot(report);
            const dirs = report.skillsDirs ?? [];
            const working = (prefix: string) => acting === `${prefix}:${report.id}`;
            return (
              <section key={report.id} className="rounded-xl border border-border bg-surface/40 p-3">
                <header className="flex flex-wrap items-start gap-2">
                  <HarnessIcon id={report.id} className="mt-0.5 size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[13px] font-semibold text-foreground">{report.name}</span>
                      {tool?.installed ? (
                        <span className="rounded-full bg-success/12 px-1.5 py-px font-mono text-[10px] text-success">
                          {tool.current || "—"}
                        </span>
                      ) : tool ? (
                        <span className="rounded-full bg-muted px-1.5 py-px text-[10px] text-ink-3">
                          {t("harnessTools.cliMissing")}
                        </span>
                      ) : (
                        <span className="rounded-full bg-muted px-1.5 py-px text-[10px] text-ink-3">
                          {t("harnessTools.guiOnly")}
                        </span>
                      )}
                      {tool?.broken ? (
                        <span className="flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-px text-[10px] text-warning">
                          <TriangleAlert className="size-2.5" />
                          {t("harnessTools.cliBroken")}
                        </span>
                      ) : null}
                      {tool?.hasUpdate ? (
                        <span className="rounded-full bg-primary/15 px-1.5 py-px text-[10px] text-primary">
                          {t("harnessTools.cliUpdate")}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1">
                      <span className="min-w-0 truncate font-mono text-[10px] text-ink-3" dir="ltr" title={root}>
                        {root || t("harnessTools.noRoot")}
                      </span>
                      {root ? (
                        <>
                          <button
                            type="button"
                            title={t("harnessTools.openFolder")}
                            aria-label={t("harnessTools.openFolder")}
                            onClick={() => void api.revealPath(root)}
                            className="rounded p-0.5 text-ink-3 hover:bg-surface-2 hover:text-foreground"
                          >
                            <FolderOpen className="size-3" />
                          </button>
                          <button
                            type="button"
                            title={t("harnessTools.copyPath")}
                            aria-label={t("harnessTools.copyPath")}
                            onClick={() => copy(root)}
                            className="rounded p-0.5 text-ink-3 hover:bg-surface-2 hover:text-foreground"
                          >
                            <Copy className="size-3" />
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="iconSm"
                      variant="ghost"
                      title={t("harnessTools.refreshOne")}
                      aria-label={t("harnessTools.refreshOne")}
                      disabled={refreshing === report.id}
                      onClick={() => void refreshOne(report)}
                    >
                      <RefreshCw className={refreshing === report.id ? "animate-spin" : undefined} />
                    </Button>
                    {tool && (!tool.installed || tool.hasUpdate || tool.broken) ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 text-[11px]"
                        disabled={working("update")}
                        onClick={() => void updateCli(report)}
                      >
                        {working("update") ? <Loader2 className="size-3.5 animate-spin" /> : <Terminal className="size-3.5" />}
                        {t(
                          tool.installed
                            ? tool.broken
                              ? "harnessTools.repair"
                              : "harnessTools.update"
                            : "harnessTools.install",
                        )}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[11px]"
                      onClick={() => setMigration(report)}
                    >
                      {t("harnessTools.migrate")}
                    </Button>
                  </div>
                </header>

                <div className="mt-2 grid gap-1.5 border-t border-border/60 pt-2">
                  <div className="flex items-start gap-2">
                    <span className="w-12 shrink-0 pt-0.5 text-[10px] text-ink-3">{t("harnessTools.config")}</span>
                    <div className="min-w-0 flex-1">
                      {paths.length === 0 ? (
                        <span className="text-[11px] text-ink-3">{t("harnessTools.noConfig")}</span>
                      ) : (
                        paths.map((path) => (
                          <div key={path} className="flex min-w-0 items-center gap-1">
                            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-2" dir="ltr" title={path}>
                              {path}
                            </span>
                            <button
                              type="button"
                              title={t("harnessTools.openFolder")}
                              aria-label={t("harnessTools.openFolder")}
                              onClick={() => openFolder(path)}
                              className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-foreground"
                            >
                              <FolderOpen className="size-3" />
                            </button>
                            <button
                              type="button"
                              title={t("harnessTools.copyPath")}
                              aria-label={t("harnessTools.copyPath")}
                              onClick={() => copy(path)}
                              className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-foreground"
                            >
                              <Copy className="size-3" />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                    {report.configPath ? (
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          title={t("harnessTools.edit")}
                          aria-label={t("harnessTools.edit")}
                          onClick={() => setEditing({ id: report.id, name: report.name })}
                          className="rounded p-1 text-ink-3 hover:bg-primary/10 hover:text-primary"
                        >
                          <FileCode className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          title={t("harnessTools.backup")}
                          aria-label={t("harnessTools.backup")}
                          disabled={working("backup")}
                          onClick={() => void backup(report)}
                          className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-foreground disabled:opacity-40"
                        >
                          {working("backup") ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                        </button>
                      </div>
                    ) : null}
                  </div>

                  <div className="flex items-start gap-2">
                    <span className="w-12 shrink-0 pt-0.5 text-[10px] text-ink-3">{t("harnessTools.skillsDirs")}</span>
                    <div className="min-w-0 flex-1">
                      {dirs.length === 0 ? (
                        <span className="text-[11px] text-ink-3">{t("harnessTools.noSkillsDir")}</span>
                      ) : (
                        dirs.map((path) => (
                          <div key={path} className="flex min-w-0 items-center gap-1">
                            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-2" dir="ltr" title={path}>
                              {path}
                            </span>
                            <button
                              type="button"
                              title={t("harnessTools.openFolder")}
                              aria-label={t("harnessTools.openFolder")}
                              onClick={() => void api.revealPath(path)}
                              className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-foreground"
                            >
                              <FolderOpen className="size-3" />
                            </button>
                            <button
                              type="button"
                              title={t("harnessTools.copyPath")}
                              aria-label={t("harnessTools.copyPath")}
                              onClick={() => copy(path)}
                              className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-foreground"
                            >
                              <Copy className="size-3" />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      <ConfigEditorPanel
        open={!!editing}
        harness={editing?.id ?? ""}
        name={editing?.name ?? ""}
        onClose={() => setEditing(null)}
        onSaved={() => void load()}
      />

      <Dialog open={!!migration} onOpenChange={(open) => !open && setMigration(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("harnessTools.migrationTitle", { name: migration?.name ?? "" })}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3 text-[12px] leading-5 text-ink-2">
            {migration ? (
              <>
                <p>
                  {MIGRATION_ENV[migration.id]
                    ? t("harnessTools.migrationEnv", { env: MIGRATION_ENV[migration.id] })
                    : t("harnessTools.migrationNoEnv")}
                </p>
                <p>{t("harnessTools.migrationMove", { path: migrationRoot(migration) || "—" })}</p>
                <p className="text-ink-3">{t("harnessTools.migrationWarn")}</p>
                {MIGRATION_ENV[migration.id] ? (
                  <pre className="overflow-x-auto rounded-md border border-border bg-bg-subtle p-2 font-mono text-[11px] text-ink-2">
                    {`setx ${MIGRATION_ENV[migration.id].split(" / ")[0]} "D:\\AITools\\${migration.id}"`}
                  </pre>
                ) : (
                  <pre className="overflow-x-auto rounded-md border border-border bg-bg-subtle p-2 font-mono text-[11px] text-ink-2">
                    {`mklink /J "${migrationRoot(migration) || "C:\\...\\"}" "D:\\AITools\\${migration.id}"`}
                  </pre>
                )}
              </>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setMigration(null)}>
              {t("common.close")}
            </Button>
            {migration && MIGRATION_ENV[migration.id] ? (
              <Button
                onClick={() => copy(`setx ${MIGRATION_ENV[migration.id].split(" / ")[0]} "D:\\AITools\\${migration.id}"`)}
              >
                <Copy className="size-3.5" />
                {t("harnessTools.copyCommand")}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
