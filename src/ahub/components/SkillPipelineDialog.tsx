import { CheckCircle2, CircleDashed, FolderOpen, Loader2, Play, RotateCcw, SkipForward, XCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/ahub/components/ui/badge";
import { Button } from "@/ahub/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ahub/components/ui/dialog";
import { cn } from "@/ahub/lib/utils";

export type PipelineStepId = "vet" | "summary" | "pack";
export type PipelineStepResult = { ok: number; failed: number; note?: string };
type Status = "idle" | "running" | "done" | "failed" | "skipped";

const STEPS: { id: PipelineStepId; titleKey: string; hintKey: string }[] = [
  { id: "vet", titleKey: "skills.pipeStepVet", hintKey: "skills.pipeStepVetHint" },
  { id: "summary", titleKey: "skills.pipeStepSummary", hintKey: "skills.pipeStepSummaryHint" },
  { id: "pack", titleKey: "skills.pipeStepPack", hintKey: "skills.pipeStepPackHint" },
];

/**
 * 发版流水线：审查 → 摘要 → 打包，一条链跑完。
 *
 * 这三步原本是三个独立按钮，顺序还得自己记（先体检再发版，不然打出来的包带着
 * 明显的规范问题）。收进一条流水线后每步都有状态与「只重跑这一步」，
 * 中途失败不用从头再来，也不会漏步。
 */
export function SkillPipelineDialog({
  open,
  onOpenChange,
  count,
  outDir,
  onPickOutDir,
  runStep,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 本次要处理的技能数量 */
  count: number;
  /** 打包输出目录；为空时打包步骤会跳过（并提示去选目录） */
  outDir: string;
  onPickOutDir: () => Promise<void> | void;
  runStep: (id: PipelineStepId) => Promise<PipelineStepResult>;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Record<PipelineStepId, Status>>({ vet: "idle", summary: "idle", pack: "idle" });
  const [results, setResults] = useState<Partial<Record<PipelineStepId, PipelineStepResult>>>({});
  const [running, setRunning] = useState(false);

  const reset = () => {
    setStatus({ vet: "idle", summary: "idle", pack: "idle" });
    setResults({});
  };

  const runOne = async (id: PipelineStepId) => {
    if (id === "pack" && !outDir) {
      setStatus((s) => ({ ...s, pack: "skipped" }));
      return;
    }
    setStatus((s) => ({ ...s, [id]: "running" }));
    try {
      const result = await runStep(id);
      setResults((r) => ({ ...r, [id]: result }));
      setStatus((s) => ({ ...s, [id]: result.failed > 0 || result.ok === 0 ? "failed" : "done" }));
    } catch (e) {
      setResults((r) => ({ ...r, [id]: { ok: 0, failed: count, note: String(e) } }));
      setStatus((s) => ({ ...s, [id]: "failed" }));
    }
  };

  const runAll = async () => {
    setRunning(true);
    try {
      for (const step of STEPS) {
        const current = status[step.id];
        if (current === "running") continue;
        await runOne(step.id);
      }
    } finally {
      setRunning(false);
    }
  };

  const retry = async (id: PipelineStepId) => {
    setRunning(true);
    try {
      await runOne(id);
    } finally {
      setRunning(false);
    }
  };

  const icon = (state: Status) => {
    if (state === "running") return <Loader2 className="size-4 animate-spin text-primary" />;
    if (state === "done") return <CheckCircle2 className="size-4 text-success" />;
    if (state === "failed") return <XCircle className="size-4 text-danger" />;
    if (state === "skipped") return <SkipForward className="size-4 text-ink-3" />;
    return <CircleDashed className="size-4 text-ink-3" />;
  };

  const stateText = (id: PipelineStepId) => {
    const state = status[id];
    const result = results[id];
    if (state === "idle") return t("skills.pipeIdle");
    if (state === "running") return t("skills.pipeRunning");
    if (state === "skipped") return t("skills.pipeSkipped");
    if (!result) return t("skills.pipeIdle");
    if (state === "failed") return t("skills.pipeFailed", { ok: result.ok, failed: result.failed });
    return t("skills.pipeDone", { ok: result.ok, failed: result.failed });
  };

  const finished = STEPS.every((step) => ["done", "failed", "skipped"].includes(status[step.id]));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && running) return;
        if (next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("skills.pipeTitle")}</DialogTitle>
          <DialogDescription>{t("skills.pipeHint", { n: count })}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
            <FolderOpen className="size-3.5 shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2">
              {outDir || t("skills.pipeNoOutDir")}
            </span>
            <Button size="sm" variant="secondary" className="h-7 shrink-0 px-2 text-[11px]" onClick={() => void onPickOutDir()} disabled={running}>
              {t("skills.pipePickOutDir")}
            </Button>
          </div>

          <ol className="mt-3 flex flex-col gap-1.5">
            {STEPS.map((step, index) => (
              <li
                key={step.id}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg border px-3 py-2",
                  status[step.id] === "running" ? "border-primary/40 bg-primary-soft/30" : "border-border",
                )}
              >
                <span className="w-4 shrink-0 text-center font-mono text-[10px] text-ink-3">{index + 1}</span>
                {icon(status[step.id])}
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] text-foreground">{t(step.titleKey)}</span>
                  <span className="block truncate text-[10.5px] text-ink-3">{t(step.hintKey)}</span>
                </span>
                <Badge
                  variant={
                    status[step.id] === "done"
                      ? "success"
                      : status[step.id] === "failed"
                        ? "danger"
                        : status[step.id] === "running"
                          ? "info"
                          : "muted"
                  }
                >
                  {stateText(step.id)}
                </Badge>
                {status[step.id] === "failed" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-1.5 text-[10.5px]"
                    disabled={running}
                    onClick={() => void retry(step.id)}
                  >
                    <RotateCcw className="size-3" />
                    {t("skills.pipeRetry")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>

          {results.vet?.note || results.summary?.note || results.pack?.note ? (
            <p className="mt-2 whitespace-pre-wrap rounded-lg bg-bg-subtle px-3 py-2 text-[10.5px] leading-4 text-ink-2">
              {[results.vet?.note, results.summary?.note, results.pack?.note].filter(Boolean).join("\n")}
            </p>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <Button variant="secondary" disabled={running} onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
          {finished || running ? (
            <Button variant="secondary" disabled={running} onClick={() => void runAll()}>
              {running ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
              {running ? t("skills.pipeRunningAll") : t("skills.pipeRerun")}
            </Button>
          ) : (
            <Button disabled={count === 0} onClick={() => void runAll()}>
              <Play className="size-3.5" />
              {t("skills.pipeStart")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
