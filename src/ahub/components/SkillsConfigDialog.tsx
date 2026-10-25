import { Loader2, Package, Plus, RefreshCw, RotateCw, Unlink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/ahub/components/ui/badge";
import { Button } from "@/ahub/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ahub/components/ui/dialog";
import { HarnessIcon } from "@/ahub/components/HarnessIcon";
import { SearchBar } from "@/ahub/components/SearchBar";
import { api } from "@/ahub/lib/api";
import { dirBase, isSkillApplied } from "@/ahub/lib/skillHarness";
import type { HarnessReport, SkillMeta } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

/**
 * 「按工具管理技能」：技能版的批量配置。
 *
 * 与 MCP 的 HarnessConfigDialog 同一套交互——左选工具，右侧上半是已接入的
 * （可更新 / 解绑），下半是中枢里可接入的。区别是技能没有单文件配置可编辑，
 * 也没有「与池子参数比对」的问题，唯一要判断的是工具目录里的副本
 * 是否比中枢旧（SKILL.md 的修改时间）。
 */
export function SkillsConfigDialog({
  open,
  onOpenChange,
  reports,
  scanning,
  onRescan,
  skills,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  reports: HarnessReport[] | null;
  scanning: boolean;
  onRescan: () => void;
  skills: SkillMeta[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [activeId, setActiveId] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null); // 正在操作的行 key
  // 搜已接入与可接入两个列表；切工具不清空，关掉重开才清
  const [q, setQ] = useState("");

  const list = useMemo(
    () => (reports ?? []).filter((r) => r.supportsSkills || r.skills.length > 0),
    [reports],
  );

  useEffect(() => {
    if (open) {
      setQ("");
      if (list.length && !list.some((r) => r.id === activeId)) setActiveId(list[0].id);
    }
  }, [open, list, activeId]);

  const active = list.find((r) => r.id === activeId) ?? null;
  const needle = q.trim().toLowerCase();

  // 工具目录里的技能 ↔ 中枢技能：目录名优先，frontmatter name 兜底（与接入时的复制规则一致）
  const hubOf = useMemo(() => {
    const byDir = new Map(skills.map((s) => [s.dirName.toLowerCase(), s]));
    const byName = new Map(skills.map((s) => [s.name.toLowerCase(), s]));
    return (d: { path: string; name: string }) =>
      byDir.get(dirBase(d.path)) ?? byName.get(d.name.toLowerCase()) ?? null;
  }, [skills]);

  const configured = useMemo(() => {
    if (!active) return [];
    return active.skills.map((d) => {
      const hub = hubOf(d);
      const hubMs = hub ? Date.parse(hub.updatedAt) : NaN;
      // 工具副本的 SKILL.md 修改时间早于中枢 → 中枢有更新可覆盖
      const outdated = !!hub && Number.isFinite(hubMs) && hubMs > d.updatedAt;
      return { d, hub, outdated };
    });
  }, [active, hubOf]);

  const configuredHit = (row: { d: { path: string; name: string }; hub: SkillMeta | null }) => {
    if (!needle) return true;
    const name = (row.hub?.name || row.d.name || dirBase(row.d.path)).toLowerCase();
    return name.includes(needle) || row.d.path.toLowerCase().includes(needle);
  };
  const addable = useMemo(() => {
    if (!active) return [];
    return skills.filter((s) => !isSkillApplied(active, s));
  }, [active, skills]);
  const addableHit = (s: SkillMeta) =>
    !needle || s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle);

  const runOne = async (
    rowKey: string,
    action: () => Promise<{ errors: string[]; warnings: string[]; backups: string[] }>,
    okText: string,
  ) => {
    setBusy(rowKey);
    try {
      const res = await action();
      if (res.errors.length) {
        toast.error(res.errors[0]);
        return;
      }
      if (res.warnings.length) {
        res.warnings.forEach((w) => toast.warning(w));
        return;
      }
      const bak = res.backups[0]?.split(/[\\/]/).pop();
      toast.success(okText + (bak ? ` · ${t("skills.backupMade")}: ${bak}` : ""));
      onRescan();
      onChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const applyOne = (dirName: string) => {
    if (!active) return;
    void runOne(`add:${dirName}`, () => api.applyToHarness(active.id, "skills", [dirName]), t("skills.appliedToTool", { name: active.name }));
  };

  const updateOne = (dirName: string) => {
    if (!active) return;
    void runOne(`upd:${dirName}`, () => api.applyToHarness(active.id, "skills", [dirName]), t("skills.updatedInTool", { name: active.name }));
  };

  const unbindOne = (dirName: string) => {
    if (!active) return;
    void runOne(`rm:${dirName}`, () => api.removeFromHarness(active.id, "skills", [dirName]), t("skills.unboundFromTool", { name: active.name }));
  };

  const fmtMs = (ms: number) => (ms > 0 ? new Date(ms).toLocaleString() : "—");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide className="h-[86vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="size-4 text-primary" />
            {t("skills.harnessCfgTitle")}
          </DialogTitle>
          <DialogDescription>{t("skills.harnessCfgDesc")}</DialogDescription>
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
            <div className="py-16 text-center text-xs text-ink-3">{t("skills.noSkillsHarness")}</div>
          </DialogBody>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* 左：工具列表 */}
            <div className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border p-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] font-medium text-ink-3">{t("skills.pickHarness")}</span>
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
                    {r.skills.length}
                  </span>
                </button>
              ))}
            </div>

            {/* 右：该工具的技能管理 */}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
              {!active ? null : (
                <>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-foreground">{active.name}</div>
                      <div className="truncate font-mono text-[10px] text-ink-3" dir="ltr">
                        {active.skillsDirs[0] || "—"}
                      </div>
                    </div>
                  </div>

                  <SearchBar
                    value={q}
                    onChange={setQ}
                    placeholder={t("skills.cfgSearchPlaceholder")}
                    className="mb-3 w-full"
                  />

                  {/* 已接入（置顶） */}
                  <div className="mb-2 text-[11px] font-medium text-ink-3">
                    {t("skills.cfgExisting")} · {configured.filter(configuredHit).length}
                  </div>
                  {configured.length === 0 ? (
                    <div className="mb-4 rounded-lg border border-dashed border-border px-3 py-3 text-[11px] text-ink-3">
                      {t("skills.cfgNoneExisting")}
                    </div>
                  ) : configured.filter(configuredHit).length === 0 ? (
                    <div className="mb-4 rounded-lg border border-dashed border-border px-3 py-3 text-[11px] text-ink-3">
                      {t("skills.cfgNoMatch", { q: q.trim() })}
                    </div>
                  ) : (
                    <div className="mb-4 flex flex-col gap-1.5">
                      {configured.filter(configuredHit).map(({ d, hub, outdated }) => (
                        <div key={d.path} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate font-mono text-xs font-medium text-foreground">{hub?.name || d.name || dirBase(d.path)}</span>
                              {hub ? <Badge variant="outline">{t("skills.inHub")}</Badge> : null}
                              {outdated ? <Badge variant="warning">{t("skills.outdatedRow")}</Badge> : null}
                            </div>
                            <div className="truncate text-[10px] text-ink-3" dir="ltr">
                              {t("skills.appliedAt", { time: fmtMs(d.updatedAt) })}
                            </div>
                          </div>
                          {hub && outdated ? (
                            <Button size="sm" variant="secondary" className="h-7 px-2 text-[11px]" disabled={busy === `upd:${hub.dirName}`} onClick={() => void updateOne(hub.dirName)}>
                              <RotateCw className="size-3.5" />
                              {t("skills.btnUpdate")}
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[11px] text-danger hover:bg-danger/10"
                            disabled={busy === `rm:${(hub?.dirName ?? dirBase(d.path))}`}
                            onClick={() => void unbindOne(hub?.dirName ?? dirBase(d.path))}
                          >
                            <Unlink className="size-3.5" />
                            {t("skills.btnUnbind")}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 中枢可接入 */}
                  <div className="mb-2 text-[11px] font-medium text-ink-3">
                    {t("skills.cfgAddable")} · {addable.filter(addableHit).length}
                  </div>
                  {addable.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border px-3 py-3 text-[11px] text-ink-3">
                      {t("skills.cfgNoneAddable")}
                    </div>
                  ) : addable.filter(addableHit).length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border px-3 py-3 text-[11px] text-ink-3">
                      {t("skills.cfgNoMatch", { q: q.trim() })}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {addable.filter(addableHit).map((s) => (
                        <div key={s.dirName} className="flex items-center gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2">
                          <div className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-xs font-medium text-foreground">{s.name}</span>
                            <span className="block truncate text-[10px] text-ink-3">{s.description}</span>
                          </div>
                          <Button size="sm" className="h-7 px-2.5 text-[11px]" disabled={busy === `add:${s.dirName}`} onClick={() => void applyOne(s.dirName)}>
                            <Plus className="size-3.5" />
                            {t("skills.btnAdd")}
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
          <span className="mr-auto text-[11px] text-ink-3">{t("skills.harnessCfgHint")}</span>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
