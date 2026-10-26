import { ChevronRight, Download, FolderOpen, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/ahub/components/ConfirmDialog";
import { HarnessIcon } from "@/ahub/components/HarnessIcon";
import { Button } from "@/ahub/components/ui/button";
import { api } from "@/ahub/lib/api";
import { loadHarnessReports } from "@/ahub/lib/harnessScan";
import { dirBase } from "@/ahub/lib/skillHarness";
import type { HarnessReport } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";
import { useData } from "@/ahub/stores/data";

/**
 * 本机工具里的技能：直接读各 harness 的技能目录，一眼看到「工具里到底有什么」。
 *
 * 和技能页分工：技能页管中枢池子（自己的东西，不看来源）；这里管别人家目录，
 * 覆盖更新、移出、导入池子都立刻写盘，所以每个破坏性操作都单独确认。
 */
export function HarnessSkillsSection() {
  const { t } = useTranslation();
  const skills = useData((s) => s.skills);
  const loadSkills = useData((s) => s.loadSkills);
  const [reports, setReports] = useState<HarnessReport[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<{ report: HarnessReport; dirName: string; label: string } | null>(null);

  const load = async () => {
    setBusy(true);
    try {
      setReports(await loadHarnessReports());
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const hub = useMemo(() => new Map(skills.map((s) => [s.dirName.toLowerCase(), s])), [skills]);
  const tools = useMemo(() => (reports ?? []).filter((r) => r.supportsSkills), [reports]);
  const total = useMemo(() => tools.reduce((n, r) => n + (r.skills?.length ?? 0), 0), [tools]);

  const act = async (key: string, run: () => Promise<unknown>, done: string) => {
    setActing(key);
    try {
      await run();
      toast.success(done);
      await load();
      await loadSkills();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setActing(null);
    }
  };

  const fmt = (ms: number) => (ms > 0 ? new Date(ms).toLocaleDateString() : "—");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-3">
          {t("harnessSkills.summary", { tools: tools.length, skills: total })}
        </span>
        <Button size="sm" variant="secondary" className="ml-auto h-7 text-[11px]" disabled={busy} onClick={() => void load()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          {t("harnessSkills.refresh")}
        </Button>
      </div>

      {reports === null ? (
        <div className="py-6 text-center text-xs text-ink-3">{t("common.loading")}</div>
      ) : tools.length === 0 ? (
        <div className="py-6 text-center text-xs text-ink-3">{t("harnessSkills.empty")}</div>
      ) : (
        tools.map((r) => {
          const open = !collapsed.has(r.id);
          const skills = r.skills ?? [];
          const dirs = r.skillsDirs ?? [];
          return (
            <section key={r.id} className="rounded-xl border border-border bg-surface/40">
              <header className="flex flex-wrap items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(r.id)) next.delete(r.id);
                      else next.add(r.id);
                      return next;
                    })
                  }
                  className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
                >
                  <ChevronRight className={cn("size-3.5 shrink-0 text-ink-3 transition-transform", open && "rotate-90")} />
                  <HarnessIcon id={r.id} className="size-4 shrink-0" />
                  <span className="truncate text-[12.5px] font-semibold text-foreground">{r.name}</span>
                  <span className="rounded-full bg-surface-2 px-1.5 py-px font-mono text-[10px] tabular-nums text-ink-3">
                    {skills.length}
                  </span>
                </button>
                {dirs[0] ? (
                  <Button
                    size="iconSm"
                    variant="ghost"
                    title={t("harnessSkills.reveal")}
                    onClick={() => void api.revealPath(dirs[0])}
                  >
                    <FolderOpen />
                  </Button>
                ) : null}
              </header>

              {open ? (
                skills.length === 0 ? (
                  <p className="px-3 pb-3 text-[11px] text-ink-3">{t("harnessSkills.noSkills")}</p>
                ) : (
                  <div className="flex flex-col border-t border-border/60">
                    {skills.map((d) => {
                      const dirName = dirBase(d.path);
                      const inHub = hub.get(dirName);
                      const key = `${r.id}:${dirName}`;
                      return (
                        <div key={d.path} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate font-mono text-[11.5px] text-foreground">{inHub?.name ?? d.name}</span>
                              <span
                                className={cn(
                                  "shrink-0 rounded px-1 py-px text-[9.5px]",
                                  inHub ? "bg-primary-soft text-primary" : "bg-warning/15 text-warning",
                                )}
                              >
                                {t(inHub ? "harnessSkills.inHub" : "harnessSkills.onlyTool")}
                              </span>
                            </div>
                            <div className="truncate text-[10.5px] text-ink-3" title={d.path}>
                              {d.description || d.path} · {fmt(d.updatedAt)}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            {inHub ? (
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-6 px-2 text-[10.5px]"
                                disabled={acting === key}
                                onClick={() =>
                                  void act(
                                    key,
                                    () => api.applyToHarness(r.id, "skills", [dirName]),
                                    t("harnessSkills.updated", { skill: inHub.name, name: r.name }),
                                  )
                                }
                              >
                                {acting === key ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
                                {t("harnessSkills.update")}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-6 px-2 text-[10.5px]"
                                disabled={acting === key}
                                onClick={() =>
                                  void act(
                                    key,
                                    () => api.importSkillFolder(d.path, false),
                                    t("harnessSkills.imported", { skill: d.name }),
                                  )
                                }
                              >
                                {acting === key ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
                                {t("harnessSkills.importToHub")}
                              </Button>
                            )}
                            <Button
                              size="iconSm"
                              variant="ghost"
                              title={t("harnessSkills.reveal")}
                              onClick={() => void api.revealPath(d.path)}
                            >
                              <FolderOpen />
                            </Button>
                            <Button
                              size="iconSm"
                              variant="ghost"
                              className="text-ink-3 hover:text-danger"
                              title={t("harnessSkills.remove")}
                              onClick={() => setRemoving({ report: r, dirName, label: inHub?.name ?? d.name })}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : null}
            </section>
          );
        })
      )}

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(v) => !v && setRemoving(null)}
        title={t("harnessSkills.removeTitle")}
        message={t("harnessSkills.removeMsg", { name: removing?.report.name ?? "", skill: removing?.label ?? "" })}
        danger
        onConfirm={() => {
          if (!removing) return;
          const { report, dirName } = removing;
          setRemoving(null);
          void act(
            `${report.id}:${dirName}`,
            () => api.removeFromHarness(report.id, "skills", [dirName]),
            t("harnessSkills.removed", { skill: removing.label, name: report.name }),
          );
        }}
      />
    </div>
  );
}
