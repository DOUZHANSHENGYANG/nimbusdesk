import { AlertTriangle, FileCode, FileJson, FolderOpen, Loader2, Plus, RefreshCw, RotateCw, Save, Server, Unlink, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/ahub/components/ui/badge";
import { Button } from "@/ahub/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ahub/components/ui/dialog";
import { Textarea } from "@/ahub/components/ui/input";
import { HarnessIcon } from "@/ahub/components/HarnessIcon";
import { SearchBar } from "@/ahub/components/SearchBar";
import { api } from "@/ahub/lib/api";
import type { HarnessReport, McpServer } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

/** 池中 MCP 与工具内已配置条目是否连接参数不同（需要更新） */
function differs(pool: McpServer, cfg: { transport?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }): boolean {
  const norm = (v: unknown) => JSON.stringify(v ?? null);
  return (
    (pool.transport ?? "") !== (cfg.transport ?? "") ||
    (pool.command ?? "") !== (cfg.command ?? "") ||
    norm(pool.args) !== norm(cfg.args) ||
    norm(pool.env) !== norm(cfg.env) ||
    (pool.url ?? "") !== (cfg.url ?? "") ||
    norm(pool.headers) !== norm(cfg.headers)
  );
}

/**
 * 「按工具配置」：以某个 AI 工具为中心，集中管理它的 MCP。
 * 上半部为该工具已配置的 MCP（可更新 / 解绑 / 编辑），下半部为全局池子中可一键添加的 MCP。
 */
export function HarnessConfigDialog({
  open,
  onOpenChange,
  reports,
  scanning,
  onRescan,
  pool,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  reports: HarnessReport[] | null;
  scanning: boolean;
  onRescan: () => void;
  pool: McpServer[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [activeId, setActiveId] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null); // 正在操作的行 key
  // 搜已配置与可添加两个列表；切工具不清空，关掉重开才清
  const [q, setQ] = useState("");

  // 内嵌配置编辑器
  const [editOpen, setEditOpen] = useState(false);
  const [editText, setEditText] = useState("");
  const [editPath, setEditPath] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  const list = useMemo(
    () => (reports ?? []).filter((r) => r.supportsMcp || r.mcpServers.length > 0),
    [reports],
  );

  useEffect(() => {
    if (open) {
      setEditOpen(false);
      setImportOpen(false);
      setImportText("");
      setQ("");
      if (list.length && !list.some((r) => r.id === activeId)) setActiveId(list[0].id);
    }
  }, [open, list, activeId]);

  const active = list.find((r) => r.id === activeId) ?? null;
  const needle = q.trim().toLowerCase();
  const poolByName = useMemo(() => new Map(pool.map((p) => [p.name, p])), [pool]);

  // 该工具已配置的 MCP（置顶）
  const configured = useMemo(() => {
    if (!active) return [];
    return active.mcpServers.map((cfg) => {
      const p = poolByName.get(cfg.name);
      return { cfg, pool: p, outdated: p ? differs(p, cfg) : false };
    });
  }, [active, poolByName]);

  const configuredHit = (c: { cfg: { name: string; transport?: string; command?: string; args?: string[]; url?: string } }) => {
    if (!needle) return true;
    return (
      c.cfg.name.toLowerCase().includes(needle) ||
      rowSummary(c.cfg).toLowerCase().includes(needle)
    );
  };

  // 池子中尚未配置到该工具的
  const addable = useMemo(() => {
    if (!active) return [];
    const have = new Set(active.mcpServers.map((x) => x.name));
    return pool.filter((p) => !have.has(p.name));
  }, [active, pool]);

  const addableHit = (p: McpServer) => {
    if (!needle) return true;
    return (
      p.name.toLowerCase().includes(needle) ||
      (p.transport === "stdio" ? `${p.command} ${p.args.join(" ")}` : p.url).toLowerCase().includes(needle)
    );
  };

  const syncTargets = async (name: string, hid: string, add: boolean) => {
    const p = poolByName.get(name);
    if (!p) return;
    const set = new Set(p.targets ?? []);
    if (add) set.add(hid);
    else set.delete(hid);
    await api.saveMcp({ ...p, targets: [...set] });
  };

  const addToHarness = async (name: string) => {
    if (!active) return;
    setBusy(`add:${name}`);
    try {
      const res = await api.applyToHarness(active.id, "mcp", [name]);
      if (res.errors.length) {
        toast.error(res.errors[0]);
        return;
      }
      if (res.warnings.length) {
        res.warnings.forEach((w) => toast.warning(w));
        return;
      }
      await syncTargets(name, active.id, true);
      toast.success(t("mcp.addedTo", { name: active.name }));
      onRescan();
      onChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const updateInHarness = async (name: string) => {
    if (!active) return;
    setBusy(`upd:${name}`);
    try {
      const res = await api.applyToHarness(active.id, "mcp", [name]);
      if (res.errors.length) {
        toast.error(res.errors[0]);
        return;
      }
      if (res.warnings.length) {
        res.warnings.forEach((w) => toast.warning(w));
        return;
      }
      await syncTargets(name, active.id, true);
      toast.success(t("mcp.updatedIn", { name: active.name }));
      onRescan();
      onChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const unbind = async (name: string) => {
    if (!active) return;
    setBusy(`rm:${name}`);
    try {
      const res = await api.removeFromHarness(active.id, "mcp", [name]);
      if (res.errors.length) {
        toast.error(res.errors[0]);
        return;
      }
      await syncTargets(name, active.id, false);
      const bak = res.backups[0]?.split(/[\\/]/).pop();
      toast.success(t("mcp.unboundFrom", { name: active.name }) + (bak ? ` · ${t("mcp.backupMade")}: ${bak}` : ""));
      onRescan();
      onChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const openEditor = async () => {
    if (!active) return;
    setEditOpen(true);
    setEditText("");
    setEditPath(active.configPath);
    setEditError("");
    setEditLoading(true);
    try {
      const res = await api.readHarnessConfig(active.id);
      setEditText(res.text);
      setEditPath(res.path);
    } catch (e) {
      setEditError(String(e));
    } finally {
      setEditLoading(false);
    }
  };

  const saveEditor = async () => {
    if (!active) return;
    setEditSaving(true);
    setEditError("");
    try {
      const res = await api.writeHarnessConfig(active.id, editText);
      const bak = res.backup?.split(/[\\/]/).pop();
      toast.success(t("mcp.cfgSaved", { name: active.name }) + (bak ? ` · ${t("mcp.backupMade")}: ${bak}` : ""));
      onRescan();
      onChanged();
      setEditOpen(false);
    } catch (e) {
      setEditError(String(e));
    } finally {
      setEditSaving(false);
    }
  };

  const doImportJson = async () => {
    if (!active) return;
    try {
      const merged = await api.mergeHarnessConfig(active.id, editText, importText);
      setEditText(merged);
      setImportOpen(false);
      setImportText("");
      toast.success(t("mcp.importMerged"));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const rowSummary = (c: { transport?: string; command?: string; args?: string[]; url?: string }) =>
    c.transport === "stdio" ? `${c.command ?? ""} ${(c.args ?? []).join(" ")}`.trim() : c.url ?? "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide className="h-[86vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="size-4 text-primary" />
            {t("mcp.harnessCfgTitle")}
          </DialogTitle>
          <DialogDescription>{t("mcp.harnessCfgDesc")}</DialogDescription>
        </DialogHeader>

        {reports === null ? (
          <DialogBody>
            <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-3">
              <Loader2 className="size-6 animate-spin" />
              <span className="text-xs">{t("mcp.scanTip")}</span>
            </div>
          </DialogBody>
        ) : list.length === 0 ? (
          <DialogBody>
            <div className="py-16 text-center text-xs text-ink-3">{t("mcp.noMcpHarness")}</div>
          </DialogBody>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* 左：工具列表 */}
            <div className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border p-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] font-medium text-ink-3">{t("mcp.pickHarness")}</span>
                <button
                  type="button"
                  title={t("common.rescan")}
                  onClick={onRescan}
                  className="rounded p-1 text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-foreground"
                >
                  <RefreshCw className={cn("size-3.5", scanning && "animate-spin")} />
                </button>
              </div>
              {list.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setActiveId(r.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-2 text-left outline-none transition-colors",
                    r.id === activeId ? "bg-primary-soft text-primary" : "text-ink-2 hover:bg-surface-2 hover:text-foreground",
                  )}
                >
                  <HarnessIcon id={r.id} className={cn("size-4 shrink-0", r.id === activeId ? "text-primary" : "text-ink-3")} />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{r.name}</span>
                  <span className={cn("shrink-0 text-[10px]", r.id === activeId ? "text-primary" : "text-ink-3")}>
                    {r.mcpServers.length}
                  </span>
                </button>
              ))}
            </div>

            {/* 右：该工具的 MCP 管理 */}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
              {!active ? null : (
                <>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-foreground">{active.name}</div>
                      <div className="truncate font-mono text-[10px] text-ink-3" dir="ltr">
                        {active.configPath || "—"}
                      </div>
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => void openEditor()} disabled={!active.configPath}>
                      <FileCode className="size-3.5" />
                      {t("mcp.btnEditCfg")}
                    </Button>
                  </div>

                  <SearchBar
                    value={q}
                    onChange={setQ}
                    placeholder={t("mcp.cfgSearchPlaceholder")}
                    className="mb-3 w-full"
                  />

                  {/* 已配置（置顶） */}
                  <div className="mb-2 text-[11px] font-medium text-ink-3">
                    {t("mcp.cfgExisting")} · {configured.filter(configuredHit).length}
                  </div>
                  {configured.length === 0 ? (
                    <div className="mb-4 rounded-lg border border-dashed border-border px-3 py-3 text-[11px] text-ink-3">
                      {t("mcp.cfgNoneExisting")}
                    </div>
                  ) : configured.filter(configuredHit).length === 0 ? (
                    <div className="mb-4 rounded-lg border border-dashed border-border px-3 py-3 text-[11px] text-ink-3">
                      {t("mcp.cfgNoMatch", { q: q.trim() })}
                    </div>
                  ) : (
                    <div className="mb-4 flex flex-col gap-1.5">
                      {configured.filter(configuredHit).map(({ cfg, pool: p, outdated }) => (
                        <div
                          key={cfg.name}
                          className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate font-mono text-xs font-medium text-foreground">{cfg.name}</span>
                              {p ? <Badge variant="outline">{t("mcp.inPool")}</Badge> : null}
                              {outdated ? <Badge variant="warning">{t("mcp.outdated")}</Badge> : null}
                            </div>
                            <div className="truncate font-mono text-[10px] text-ink-3" dir="ltr">
                              {rowSummary(cfg)}
                            </div>
                          </div>
                          {p && outdated ? (
                            <Button size="sm" variant="secondary" className="h-7 px-2 text-[11px]" disabled={busy === `upd:${cfg.name}`} onClick={() => void updateInHarness(cfg.name)}>
                              <RotateCw className="size-3.5" />
                              {t("mcp.btnUpdate")}
                            </Button>
                          ) : null}
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-danger hover:bg-danger/10" disabled={busy === `rm:${cfg.name}`} onClick={() => void unbind(cfg.name)}>
                            <Unlink className="size-3.5" />
                            {t("mcp.btnUnbind")}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 池子可添加 */}
                  <div className="mb-2 text-[11px] font-medium text-ink-3">
                    {t("mcp.cfgAddable")} · {addable.filter(addableHit).length}
                  </div>
                  {addable.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border px-3 py-3 text-[11px] text-ink-3">
                      {t("mcp.cfgNoneAddable")}
                    </div>
                  ) : addable.filter(addableHit).length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border px-3 py-3 text-[11px] text-ink-3">
                      {t("mcp.cfgNoMatch", { q: q.trim() })}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {addable.filter(addableHit).map((p) => (
                        <div
                          key={p.id}
                          className="flex items-center gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-xs font-medium text-foreground">{p.name}</span>
                            <span className="block truncate font-mono text-[10px] text-ink-3" dir="ltr">
                              {p.transport === "stdio" ? `${p.command} ${p.args.join(" ")}`.trim() : p.url}
                            </span>
                          </div>
                          <Button size="sm" className="h-7 px-2.5 text-[11px]" disabled={busy === `add:${p.name}`} onClick={() => void addToHarness(p.name)}>
                            <Plus className="size-3.5" />
                            {t("mcp.btnAdd")}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <span className="mr-auto text-[11px] text-ink-3">{t("mcp.harnessCfgHint")}</span>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>

        {/* 右侧滑出的配置编辑器 */}
        <AnimatePresence>
          {editOpen && active ? (
            <motion.div
              key="cfg-editor"
              initial={{ x: "100%", opacity: 0.6 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: "100%", opacity: 0.4 }}
              transition={{ type: "spring", stiffness: 420, damping: 40 }}
              className="fixed left-1/2 top-1/2 z-[60] flex h-[86vh] w-full -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl sm:max-w-3xl"
            >
              <div className="flex items-start gap-3 border-b border-border px-5 py-4">
                <FileCode className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground">
                    {t("mcp.editCfgTitle", { name: active.name })}
                  </div>
                  <div className="truncate font-mono text-[10px] text-ink-3" dir="ltr">
                    {editPath || "—"}
                  </div>
                </div>
                <button
                  type="button"
                  title={t("mcp.revealCfg")}
                  onClick={() => editPath && void api.revealPath(editPath)}
                  className="shrink-0 rounded-md p-1.5 text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-foreground"
                >
                  <FolderOpen className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setEditOpen(false)}
                  className="shrink-0 rounded-md p-1.5 text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="min-h-0 flex-1 p-4">
                {editLoading ? (
                  <div className="flex h-full items-center justify-center gap-2 text-ink-3">
                    <Loader2 className="size-5 animate-spin" />
                    <span className="text-xs">{t("mcp.cfgLoading")}</span>
                  </div>
                ) : (
                  <Textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    spellCheck={false}
                    className="h-full min-h-full resize-none font-mono text-xs leading-relaxed whitespace-pre"
                    dir="ltr"
                  />
                )}
              </div>

              {importOpen ? (
                <div className="mx-4 mb-2 rounded-lg border border-primary/40 bg-primary-soft/40 p-3">
                  <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-primary">
                    <FileJson className="size-3.5" />
                    {t("mcp.importJsonIntoHint")}
                  </div>
                  <Textarea
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    spellCheck={false}
                    placeholder={'{"mcpServers": {"context7": {"command": "npx", "args": ["-y", "@upstash/context7-mcp"]}}}'}
                    className="min-h-28 resize-none font-mono text-xs"
                    dir="ltr"
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setImportOpen(false);
                        setImportText("");
                      }}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button size="sm" disabled={!importText.trim()} onClick={() => void doImportJson()}>
                      {t("mcp.importMergeGo")}
                    </Button>
                  </div>
                </div>
              ) : null}

              {editError ? (
                <div className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 break-all">{editError}</span>
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2 border-t border-border bg-bg-subtle px-5 py-3.5">
                <span className="mr-auto text-[11px] text-ink-3">{t("mcp.cfgEditHint")}</span>
                <Button variant="secondary" onClick={() => setImportOpen(true)} disabled={editLoading || editSaving}>
                  <FileJson className="size-3.5" />
                  {t("mcp.importJsonInto")}
                </Button>
                <Button variant="secondary" onClick={() => setEditOpen(false)} disabled={editSaving}>
                  {t("common.cancel")}
                </Button>
                <Button onClick={() => void saveEditor()} disabled={editLoading || editSaving}>
                  {editSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                  {t("common.save")}
                </Button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
