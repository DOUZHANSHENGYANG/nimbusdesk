import { Check, Loader2, Plug, Unplug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { HarnessIcon } from "@/ahub/components/HarnessIcon";
import { Button } from "@/ahub/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ahub/components/ui/dialog";
import type { ApplyResult, HarnessReport } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

type Mode = "apply" | "remove";

type ToolResult = { id: string; name: string; ok: number; failed: number; skipped: number; errors: string[] };

/** 一条待处理的条目：key 是调后端命令时用的名字（技能=dirName，MCP=name） */
export type HarnessBatchItem = {
  key: string;
  /** 已接入的 harness id 列表 */
  applied: string[];
};

/**
 * 批量接入 / 移出工具（技能与 MCP 共用）。
 *
 * 页面上已经勾好条目，这里只让用户挑工具 —— 每行直接写出「将新增 / 将移除 n 项」，
 * 跑完按工具报成功、失败、跳过。一次只做一种方向，避免同一个按钮里藏两种相反操作。
 */
export function HarnessBatchDialog({
  open,
  onOpenChange,
  kind,
  items,
  reports,
  run,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "skills" | "mcp";
  items: HarnessBatchItem[];
  reports: HarnessReport[];
  /** 调后端命令；技能只复制目录，MCP 还要同步 targets 元数据，所以交给调用方 */
  run: (harnessId: string, mode: Mode, keys: string[]) => Promise<ApplyResult>;
  /** 跑完刷新扫描结果 / 列表 */
  onDone: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("apply");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ToolResult[] | null>(null);

  const tools = useMemo(
    () => reports.filter((r) => (kind === "skills" ? r.supportsSkills : r.supportsMcp)),
    [reports, kind],
  );

  /** 每个工具下「已接入 / 未接入」的名单 */
  const plan = useMemo(() => {
    return tools.map((r) => {
      const have = items.filter((it) => it.applied.includes(r.id));
      const missing = items.filter((it) => !it.applied.includes(r.id));
      return { report: r, have, missing };
    });
  }, [tools, items]);

  const actionable = (p: (typeof plan)[number]) => (mode === "apply" ? p.missing.length : p.have.length);

  useEffect(() => {
    if (!open) return;
    setMode("apply");
    setResults(null);
    setRunning(false);
    // 默认勾上所有能处理的工具；一个都不勾用户还得自己点一遍
    setPicked(new Set(plan.filter((p) => p.missing.length > 0).map((p) => p.report.id)));
    // plan 只在打开瞬间取默认值，之后用户调模式/勾选不被覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 切到「移出」时，默认勾选有副本可移的工具
  const switchMode = (next: Mode) => {
    setMode(next);
    setResults(null);
    setPicked(new Set(plan.filter((p) => (next === "apply" ? p.missing.length : p.have.length) > 0).map((p) => p.report.id)));
  };

  const totalItems = plan.filter((p) => picked.has(p.report.id)).reduce((n, p) => n + actionable(p), 0);

  const runAll = async () => {
    const chosen = plan.filter((p) => picked.has(p.report.id) && actionable(p) > 0);
    if (!chosen.length) return;
    setRunning(true);
    const out: ToolResult[] = [];
    for (const p of chosen) {
      const keys = (mode === "apply" ? p.missing : p.have).map((it) => it.key);
      try {
        const res = await run(p.report.id, mode, keys);
        out.push({
          id: p.report.id,
          name: p.report.name,
          ok: res.applied.length,
          failed: res.errors.length,
          skipped: res.warnings.length,
          errors: res.errors,
        });
      } catch (e) {
        out.push({ id: p.report.id, name: p.report.name, ok: 0, failed: keys.length, skipped: 0, errors: [String(e)] });
      }
      setResults([...out]);
    }
    setRunning(false);
    await onDone();
  };

  const done = results !== null;
  const okCount = results?.reduce((n, r) => n + r.ok, 0) ?? 0;
  const failCount = results?.reduce((n, r) => n + r.failed, 0) ?? 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !running && onOpenChange(v)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t(kind === "skills" ? "skills.harnessDlgTitle" : "mcp.harnessDlgTitle")}</DialogTitle>
          <DialogDescription>
            {t(kind === "skills" ? "skills.harnessDlgDesc" : "mcp.harnessDlgDesc", { n: items.length })}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-2">
          <div className="flex w-fit items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5">
            {(
              [
                { m: "apply" as const, icon: Plug, key: "skills.harnessModeApply" },
                { m: "remove" as const, icon: Unplug, key: "skills.harnessModeRemove" },
              ]
            ).map(({ m, icon: Icon, key }) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                disabled={running}
                onClick={() => switchMode(m)}
                className={cn(
                  "flex h-6 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium outline-none transition-colors",
                  mode === m ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
                )}
              >
                <Icon className="size-3" />
                {t(key)}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-1">
            {plan.map((p) => {
              const n = actionable(p);
              const on = picked.has(p.report.id);
              const result = results?.find((r) => r.id === p.report.id);
              return (
                <div
                  key={p.report.id}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-2 py-1.5",
                    n === 0 ? "border-border/60 opacity-55" : on ? "border-primary/40 bg-primary-soft/25" : "border-border",
                  )}
                >
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-label={p.report.name}
                    disabled={n === 0 || running || done}
                    onClick={() =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (next.has(p.report.id)) next.delete(p.report.id);
                        else next.add(p.report.id);
                        return next;
                      })
                    }
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded border transition-colors",
                      on && n > 0 ? "border-primary bg-primary text-white" : "border-border-strong",
                    )}
                  >
                    {on && n > 0 ? <Check className="size-3" strokeWidth={3} /> : null}
                  </button>

                  <HarnessIcon id={p.report.id} className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{p.report.name}</span>

                  {result ? (
                    <span className="flex shrink-0 items-center gap-2 font-mono text-[10.5px] tabular-nums">
                      <span className="text-success">✓ {result.ok}</span>
                      {result.failed > 0 ? <span className="text-danger">✕ {result.failed}</span> : null}
                      {result.skipped > 0 ? <span className="text-ink-3">— {result.skipped}</span> : null}
                    </span>
                  ) : (
                    <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-ink-3">
                      {n === 0
                        ? mode === "apply"
                          ? t("skills.harnessAllApplied")
                          : t("skills.harnessNoCopies")
                        : mode === "apply"
                          ? t("skills.harnessWillAdd", { n })
                          : t("skills.harnessWillRemove", { n })}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {done ? (
            <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface/60 p-2">
              <span className="text-[11px] font-medium text-foreground">
                {t("skills.harnessDoneSummary", { ok: okCount, failed: failCount })}
              </span>
              {results
                ?.filter((r) => r.errors.length > 0)
                .map((r) => (
                  <span key={r.id} className="text-[10.5px] leading-snug text-danger">
                    {r.name}: {r.errors.join("; ")}
                  </span>
                ))}
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={running}>
            {done ? t("common.close") : t("common.cancel")}
          </Button>
          {done ? null : (
            <Button onClick={() => void runAll()} disabled={running || totalItems === 0}>
              {running ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
              {mode === "apply"
                ? t("skills.harnessRunApply", { n: totalItems })
                : t("skills.harnessRunRemove", { n: totalItems })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
