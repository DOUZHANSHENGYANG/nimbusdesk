import { Check, Clock, Copy, FileCode, FolderOpen, Loader2, RefreshCw, Save, Terminal, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/ahub/components/ui/badge";
import { ConfirmDialog } from "@/ahub/components/ConfirmDialog";
import { ConfigEditorPanel } from "@/ahub/components/ConfigEditorPanel";
import { HarnessIcon } from "@/ahub/components/HarnessIcon";
import { Button } from "@/ahub/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/ahub/components/ui/dialog";
import { api, copyText } from "@/ahub/lib/api";
import { loadHarnessReports, writeHarnessScan } from "@/ahub/lib/harnessScan";
import { sortByOrder } from "@/ahub/lib/harnessOrder";
import { cn } from "@/ahub/lib/utils";
import { useSettings } from "@/ahub/stores/settings";
import { useVault } from "@/ahub/stores/vault";

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
  /** 展开版本列表的那张卡（一次只展开一个） */
  const [openVersions, setOpenVersions] = useState<string | null>(null);
  /** 批量更新 CLI：确认框 + 进行中 */
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  // 配置版本库：状态与动作都在 store 里，工具卡和「全局」区块共用同一份
  const vault = useVault();
  const vaultStatus = useVault((s) => s.status);
  const vaultIndex = useVault((s) => s.index);
  const loadVault = useVault((s) => s.load);

  useEffect(() => {
    void loadVault().catch((e) => toast.error(String(e)));
  }, [loadVault]);

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
  /** 已安装且有新版本的 CLI：页头「批量更新」按它计数 */
  const updatable = useMemo(() => tools.filter((tool) => tool.installed && tool.hasUpdate), [tools]);
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

  /**
   * 右侧小导航（文档目录那味儿）：工具多了以后不用在长列表里翻，点一下就跳过去。
   * 高亮跟着滚动走 —— 用 IntersectionObserver 盯住靠上的一条带，谁落在带里谁亮，
   * 比监听 scroll 再逐个量位置省事，也不会在读的时候抖。
   */
  const [activeTool, setActiveTool] = useState("");  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const nodes = toolsToShow
      .map((report) => document.getElementById(`harness-tool-${report.id}`))
      .filter((node): node is HTMLElement => node !== null);
    if (!nodes.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting);
        if (!visible.length) return;
        const top = visible.reduce((a, b) => (a.boundingClientRect.top <= b.boundingClientRect.top ? a : b));
        setActiveTool((top.target as HTMLElement).dataset.toolId ?? "");
      },
      { rootMargin: "-8% 0px -72% 0px" },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [toolsToShow]);

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
      const saved = await vault.snapshot([report.id]);
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

  /** 一次更一批：把「已安装且有更新」的全更了，确认框里先摆清包名。 */
  const batchUpdate = async () => {
    const ids = updatable.map((tool) => tool.id);
    if (!ids.length) return;
    setBatchBusy(true);
    try {
      const outcome = await api.toolUpdate(ids);
      const ok = outcome.filter((item) => item.ok).length;
      if (ok) toast.success(t("tools.updateDone", { ok, total: outcome.length }));
      outcome.filter((item) => !item.ok).forEach((item) => toast.error(`${item.name}: ${item.message}`));
      // 版本变了：重取一遍工具列表，卡上的版本号与「可更新」标立刻跟上
      setTools((await api.toolList())?.tools ?? []);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBatchBusy(false);
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
        {/* 对齐工具卡的右缘：窄屏没有右侧目录，宽屏（lg）才需要让出它的宽度（w-32 + gap-4） */}
        <div className="ml-auto flex items-center gap-2 lg:mr-36">
          {/* 批量更新：一次更一批才用得上的动作，所以留在页头；单个工具的更新在各张卡上 */}
          {updatable.length ? (
            <Button
              size="sm"
              variant="secondary"
              className="h-7 text-[11px]"
              disabled={batchBusy}
              onClick={() => setConfirmBatch(true)}
            >
              {batchBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Terminal className="size-3.5" />}
              {t("tools.update", { n: updatable.length })}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            className="h-7 text-[11px]"
            disabled={busy || checking}
            onClick={() => void checkCli()}
          >
            {checking ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {t("harnessTools.checkCli")}
          </Button>
        </div>
      </div>

      {reports === null ? (
        <div className="py-6 text-center text-xs text-ink-3">{t("common.loading")}</div>
      ) : toolsToShow.length === 0 ? (
        <div className="py-6 text-center text-xs text-ink-3">{t("harnessTools.empty")}</div>
      ) : (
        <div className="flex items-start gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {toolsToShow.map((report) => {
            const tool = toolMap.get(report.id);
            const paths = configPaths(report);
            const root = migrationRoot(report);
            const dirs = report.skillsDirs ?? [];
            const working = (prefix: string) => acting === `${prefix}:${report.id}`;
            return (
              <section
                key={report.id}
                id={`harness-tool-${report.id}`}
                data-tool-id={report.id}
                className="scroll-mt-4 rounded-xl border border-border bg-surface/40 p-3"
              >
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
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[11px]"
                      onClick={() => setMigration(report)}
                    >
                      {t("harnessTools.migrate")}
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
                      size="iconSm"
                      variant="ghost"
                      title={t("harnessTools.refreshOne")}
                      aria-label={t("harnessTools.refreshOne")}
                      disabled={refreshing === report.id}
                      onClick={() => void refreshOne(report)}
                    >
                      <RefreshCw className={refreshing === report.id ? "animate-spin" : undefined} />
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

                  {/* 配置版本：这一份配置在版本库里存了几版、能不能回滚。
                      原来整块是「配置版本」那一页，现在跟着工具卡走 —— 一个工具的东西放一起。 */}
                  {(() => {
                    const vs = vaultStatus?.find((item) => item.harness === report.id) ?? null;
                    if (!vs?.exists) return null;
                    const watched = (vaultIndex?.watched ?? []).includes(report.id);
                    const versions = vaultIndex?.entries.find((entry) => entry.harness === report.id)?.versions ?? [];
                    const open = openVersions === report.id;
                    const latest = versions[versions.length - 1];
                    return (
                      <div className="flex items-start gap-2">
                        <span className="w-12 shrink-0 pt-0.5 text-[10px] text-ink-3">{t("harnessTools.version")}</span>
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            title={t("settings.vault")}
                            aria-pressed={watched}
                            aria-label={t("settings.vault")}
                            onClick={() =>
                              void vault
                                .setWatched(
                                  watched
                                    ? (vaultIndex?.watched ?? []).filter((id) => id !== report.id)
                                    : [...(vaultIndex?.watched ?? []), report.id],
                                )
                                .catch((e) => toast.error(String(e)))
                            }
                            className={cn(
                              "grid size-4 shrink-0 place-items-center rounded border transition-colors",
                              watched ? "border-primary bg-primary text-white" : "border-border-strong bg-surface",
                            )}
                          >
                            {watched ? <Check className="size-3" strokeWidth={3} /> : null}
                          </button>

                          {versions.length ? (
                            <button
                              type="button"
                              aria-expanded={open}
                              onClick={() => setOpenVersions(open ? null : report.id)}
                              className="inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-ink-2 outline-none hover:bg-surface-2 hover:text-foreground"
                            >
                              <Clock className="size-3 shrink-0 text-ink-3" />
                              <span className="font-mono">v{latest.v}</span>
                              <span className="text-ink-3">{t("harnessTools.versionCount", { n: versions.length })}</span>
                            </button>
                          ) : (
                            <span className="text-[11px] text-ink-3">{t("harnessTools.versionNone")}</span>
                          )}

                          {watched && !vs.upToDate ? <Badge variant="warning">{t("settings.vaultChanged")}</Badge> : null}
                        </div>
                      </div>
                    );
                  })()}

                  {openVersions === report.id
                    ? (vaultIndex?.entries.find((entry) => entry.harness === report.id)?.versions ?? [])
                        .slice()
                        .reverse()
                        .map((ver) => (
                          <div key={ver.v} className="ml-14 flex items-center gap-2 text-[11px]">
                            <span className="shrink-0 font-mono text-ink-3">v{ver.v}</span>
                            <span className="shrink-0 tabular-nums text-ink-3">{ver.savedAt}</span>
                            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-3">{ver.kind}</span>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="h-6 shrink-0 px-2 text-[10.5px]"
                              disabled={vault.busy}
                              onClick={() =>
                                void vault
                                  .restore(report.id, ver.v)
                                  .then(() => toast.success(t("settings.vaultRestored", { v: ver.v })))
                                  .catch((e) => toast.error(String(e)))
                              }
                            >
                              {t("settings.vaultRestore")}
                            </Button>
                            <button
                              type="button"
                              disabled={vault.busy}
                              onClick={() =>
                                void vault
                                  .clear([report.id])
                                  .then(() => toast.success(t("settings.vaultCleared")))
                                  .catch((e) => toast.error(String(e)))
                              }
                              className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-ink-3 outline-none hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                            >
                              {t("settings.vaultClear")}
                            </button>
                          </div>
                        ))
                    : null}
                </div>
              </section>
            );
          })}
          </div>

          {/* 右侧目录：工具名 + 跳转，高亮跟着滚动走。窄屏藏起来（卡片本来就能整列读）。 */}
          <nav
            aria-label={t("harnessTools.title")}
            className="sticky top-4 hidden w-32 shrink-0 flex-col gap-0.5 lg:flex"
          >
            {toolsToShow.map((report) => (
              <button
                key={report.id}
                type="button"
                aria-current={activeTool === report.id ? "true" : undefined}
                onClick={() =>
                  document
                    .getElementById(`harness-tool-${report.id}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
                className={cn(
                  "truncate rounded-md px-2 py-1 text-left text-[11px] outline-none transition-colors",
                  activeTool === report.id
                    ? "bg-primary-soft font-medium text-primary"
                    : "text-ink-3 hover:bg-surface-2 hover:text-foreground",
                )}
              >
                {report.name}
              </button>
            ))}
          </nav>
        </div>
      )}

      <ConfirmDialog
        open={confirmBatch}
        onOpenChange={setConfirmBatch}
        title={t("tools.confirmTitle", { n: updatable.length })}
        message={`${t("tools.confirmBody")} ${updatable.map((tool) => `${tool.name}（${tool.pkg}）`).join("、")}。${t("tools.confirmNote")}`}
        onConfirm={() => void batchUpdate()}
      />

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
