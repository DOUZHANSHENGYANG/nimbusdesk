import { listen } from "@tauri-apps/api/event";
import { Check, CircleAlert, Loader2, Sparkles, Wand2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/ahub/components/ui/badge";
import { SkillFileBrowser } from "@/ahub/components/SkillFileBrowser";
import { Button } from "@/ahub/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ahub/components/ui/dialog";
import { Input } from "@/ahub/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ahub/components/ui/select";
import { api } from "@/ahub/lib/api";
import type {
  ExploreReport,
  ImportBatchReport,
  ImportProgressEvent,
  SourceInfo,
} from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";
import { useSettings } from "@/ahub/stores/settings";

/**
 * 批量导入向导（skills-import）：
 * 探查结果 → 无法修复列表 → AI 修复 → 来源确认 → 执行（进度实时推送）。
 *
 * 程序修复在打开时就已经落盘（skill_import_apply_fixes），所以这里展示的
 * 候选是「已修复」的形态；用户只对无法修复的目录、AI 补全与来源做决定。
 */
export function ImportWizard({
  report,
  onOpenChange,
  onDone,
}: {
  /** 探查报告（由 SkillsPage 传入，null 时不显示） */
  report: ExploreReport | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [fixed, setFixed] = useState<ExploreReport | null>(null);
  const [applying, setApplying] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sources, setSources] = useState<Record<string, SourceInfo>>({});
  const [aiBusy, setAiBusy] = useState(false);
  const [aiDone, setAiDone] = useState<Set<string>>(new Set());
  /** 进入向导时判定需要 AI 的候选路径（修完后 needsAi 会变 false，列表不能因此消失） */
  const [aiTargets, setAiTargets] = useState<string[]>([]);
  const [progress, setProgress] = useState<ImportProgressEvent | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ImportBatchReport | null>(null);
  /** 决策 1：同名技能默认覆盖（用户可取消勾选，取消后同名冲突记为失败） */
  const [overwrite, setOverwrite] = useState(true);
  /** 正在看详情的候选（SKILL.md 正文 + 目录树）；null = 没开 */
  const [detail, setDetail] = useState<{ dirName: string; name: string } | null>(null);
  /** 全局设置：导入时自动生成摘要 —— 作为勾选框的初值 */
  const autoSummaryOnImport = useSettings((s) => s.info?.settings.autoSummaryOnImport ?? false);
  /** 本次导入是否生成摘要（初值跟随全局设置；只影响本次，不改全局） */
  const [generateSummary, setGenerateSummary] = useState(false);
  const unlisten = useRef<(() => void) | undefined>(undefined);
  // 打开时：程序修复先落盘（不需要用户决定），再算无法修复清单。
  // 勾选框初值依赖全局设置，故 autoSummaryOnImport 也在依赖里。
  useEffect(() => {
    if (!report) return;
    setStep(0);
    setFixed(null);
    setSelected(new Set());
    setSources({});
    setAiDone(new Set());
    setAiTargets([]);
    setProgress(null);
    setResult(null);
    setOverwrite(true);
    // 初值跟随全局设置（spec import-option）：用户取消勾选只影响本次导入
    setGenerateSummary(autoSummaryOnImport);
    setApplying(true);
    void api
      .skillImportApplyFixes(report)
      .then((r) => {
        setFixed(r);
        const ok = r.candidates.filter((c) => c.hasSkillMd && !c.problem).map((c) => c.originalPath);
        setSelected(new Set(ok));
        // AI 目标在进入向导时定下：修完后候选的 needsAi 会变 false，列表不能因此消失
        setAiTargets(r.candidates.filter((c) => c.hasSkillMd && !c.problem && c.needsAi).map((c) => c.originalPath));
        setSources(
          Object.fromEntries(
            r.candidates
              .filter((c) => c.hasSkillMd && !c.problem)
              .map((c) => [c.originalPath, c.source]),
          ),
        );
      })
      .catch((e) => {
        toast.error(String(e));
        setFixed(report);
        setSelected(
          new Set(report.candidates.filter((c) => c.hasSkillMd && !c.problem).map((c) => c.originalPath)),
        );
        setAiTargets(
          report.candidates.filter((c) => c.hasSkillMd && !c.problem && c.needsAi).map((c) => c.originalPath),
        );
        setSources(
          Object.fromEntries(
            report.candidates
              .filter((c) => c.hasSkillMd && !c.problem)
              .map((c) => [c.originalPath, c.source]),
          ),
        );
      })
      .finally(() => setApplying(false));
  }, [report, autoSummaryOnImport]);

  useEffect(() => {
    void listen<ImportProgressEvent>("import-progress", (e) => setProgress(e.payload)).then((u) => {
      unlisten.current = u;
    });
    return () => {
      unlisten.current?.();
      unlisten.current = undefined;
    };
  }, []);

  const importable = useMemo(
    () => (fixed?.candidates ?? []).filter((c) => c.hasSkillMd && !c.problem),
    [fixed],
  );
  const unrepairable = fixed?.unrepairable ?? [];
  const needsAi = useMemo(
    () => importable.filter((c) => aiTargets.includes(c.originalPath)),
    [importable, aiTargets],
  );

  /** 没有无法修复的目录时跳过第 2 步（该步只用于让用户决定继续/终止） */
  const nextStep = () => setStep((s) => (s === 0 && !unrepairable.length ? 2 : s + 1));
  const prevStep = () => setStep((s) => (s === 2 && !unrepairable.length ? 0 : s - 1));

  const close = (open: boolean) => {
    if (!open && running) return;
    if (!open && fixed) {
      // 关闭向导而导入尚未执行 → 视为取消：推 aborted 并清理解压出的临时目录
      if (!result) {
        void api
          .skillImportAbort(fixed.root, fixed.candidates.map((c) => c.originalPath))
          .catch(() => undefined);
      }
      // 决策 2：整个暂存会话目录一并删除（原目录从未被改动，删掉副本即恢复原状）
      if (fixed.sessionId) {
        void api.skillImportCleanup(fixed.sessionId).catch(() => undefined);
      }
    }
    onOpenChange(open);
  };

  /** 调 AI 补全所有 needsAi 的候选（逐个，失败不阻断其余） */
  const runAiFix = async () => {
    setAiBusy(true);
    for (const c of importable) {
      if (!aiTargets.includes(c.originalPath)) continue;
      try {
        const updated = await api.skillImportAiFix(c.originalPath, c.stagedPath);
        setFixed((prev) =>
          prev
            ? {
                ...prev,
                candidates: prev.candidates.map((x) =>
                  x.originalPath === c.originalPath ? updated : x,
                ),
              }
            : prev,
        );
        setAiDone((prev) => new Set(prev).add(c.originalPath));
      } catch (e) {
        toast.error(`${c.originalName}: ${String(e)}`);
      }
    }
    setAiBusy(false);
  };

  const run = async () => {
    if (!fixed) return;
    const picked = importable.filter((c) => selected.has(c.originalPath));
    const paths = picked.map((c) => c.originalPath);
    if (!paths.length) {
      toast.warning(t("skillImport.noneSelected"));
      return;
    }
    // 落库只动暂存副本：originalPath 是给用户认的，stagedPath 才是实际来源
    const staged: Record<string, string> = Object.fromEntries(
      picked.map((c) => [c.originalPath, c.stagedPath]),
    );
    setRunning(true);
    try {
      const r = await api.skillImportExecute(
        fixed.root,
        paths,
        staged,
        sources,
        overwrite,
        fixed.sessionId,
        generateSummary,
      );
      setResult(r);
      if (r.succeeded > 0) {
        toast.success(t("skillImport.done", { ok: r.succeeded, total: r.total }));
        onDone();
      }
      if (r.failed > 0) toast.warning(t("skillImport.partial", { n: r.failed }));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setRunning(false);
    }
  };

  const doAbort = async () => {
    // 终止：不导入任何候选；aborted 事件与临时目录清理由 close 统一处理
    toast.info(t("skillImport.aborted"));
    close(false);
  };

  const setSource = (path: string, patch: Partial<SourceInfo>) => {
    setSources((prev) => ({
      ...prev,
      [path]: { ...(prev[path] ?? { kind: "manual", value: "", confidence: "low" }), ...patch },
    }));
  };

  /** 修复项 → 一行人话 */
  const fixLabel = (kind: string) =>
    ({
      "dir-rename": t("skillImport.fixDirRename"),
      "name-sync": t("skillImport.fixNameSync"),
      "md-case": t("skillImport.fixMdCase"),
      "name-normalize": t("skillImport.fixNameNormalize"),
      "ai-description": t("skillImport.fixAiDescription"),
      "ai-description-skipped": t("skillImport.fixAiSkipped"),
    })[kind] ?? kind;

  const stepKeys = [
    t("skillImport.stepExplore"),
    t("skillImport.stepUnfixable"),
    t("skillImport.stepAi"),
    t("skillImport.stepSource"),
    t("skillImport.stepRun"),
  ];

  /** 来源类型 → 展示文案（避免动态拼 key，i18n 才能被静态检查） */
  const srcKindLabel = (kind: string) =>
    ({
      url: t("skillImport.srcUrl"),
      "local-path": t("skillImport.srcLocal"),
      custom: t("skillImport.srcCustom"),
      manual: t("skillImport.srcManual"),
    })[kind] ?? kind;

  return (
    <Dialog open={!!report} onOpenChange={close}>
      <DialogContent className="h-[88vh] max-h-[88vh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("skillImport.title")}</DialogTitle>
          <DialogDescription>{t("skillImport.hint")}</DialogDescription>
        </DialogHeader>

        <DialogBody className="flex min-h-0 flex-1 flex-col gap-3">
          {/* 步骤条 */}
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-[11px]">
            {stepKeys.map((k, i) => (
              <span
                key={k}
                className={cn(
                  "rounded-full border px-2.5 py-0.5",
                  i === step
                    ? "border-primary bg-primary-soft text-primary"
                    : i < step
                      ? "border-border text-ink-2"
                      : "border-border text-ink-3",
                )}
              >
                {i + 1} {k}
              </span>
            ))}
          </div>

          {applying ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-ink-3">
              <Loader2 className="size-4 animate-spin" />
              <span className="text-xs">{t("skillImport.applying")}</span>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {/* Step 1 探查结果 */}
              {step === 0 ? (
                <ul className="flex flex-col gap-2">
                  {importable.map((c) => (
                    <li
                      key={c.originalPath}
                      className="flex items-start gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(c.originalPath)}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const n = new Set(prev);
                            if (e.target.checked) n.add(c.originalPath);
                            else n.delete(c.originalPath);
                            return n;
                          })
                        }
                        className="mt-1 size-3.5 accent-[var(--ah-primary)]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate font-mono text-xs font-medium text-foreground">
                            {c.fixedName || c.originalName}
                          </span>
                          {c.fixedName && c.fixedName !== c.originalName ? (
                            <Badge variant="muted">{c.originalName}</Badge>
                          ) : null}
                          {c.needsAi ? <Badge variant="warning">{t("skillImport.badgeNeedsAi")}</Badge> : null}
                          {c.skillMdDescription.trim() ? null : (
                            <Badge variant="danger">{t("skillImport.badgeNoDesc")}</Badge>
                          )}
                        </span>
                        {c.skillMdDescription.trim() ? (
                          <span className="mt-0.5 line-clamp-2 block text-[11px] leading-relaxed text-ink-2">
                            {c.skillMdDescription}
                          </span>
                        ) : null}
                        {/* 决策 2：展示用户认得的原始路径（修复只动暂存副本） */}
                        <span className="mt-0.5 block break-all font-mono text-[10px] text-ink-3">
                          {c.originalPath}
                        </span>
                        {c.fixes.length ? (
                          <span className="mt-1 flex flex-wrap gap-1.5">
                            {c.fixes.map((f, i) => (
                              <span key={i} className="text-[10px] text-ink-3">
                                {fixLabel(f.kind)}：<span className="font-mono">{f.from || "—"}</span> →{" "}
                                <span className="font-mono">{f.to}</span>
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="mt-1 block text-[10px] text-ink-3">{t("skillImport.noFix")}</span>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => setDetail({ dirName: c.fixedName || c.originalName, name: c.fixedName || c.originalName })}
                        className="shrink-0 rounded-md px-2 py-1 text-[11px] text-ink-3 transition-colors hover:bg-white/5 hover:text-foreground"
                      >
                        {t("skillImport.detail")}
                      </button>
                    </li>
                  ))}
                  {!importable.length ? (
                    <li className="rounded-xl border border-border bg-card px-3 py-6 text-center text-xs text-ink-3">
                      {t("skillImport.empty")}
                    </li>
                  ) : null}
                </ul>
              ) : null}

              {/* Step 2 无法修复列表 */}
              {step === 1 ? (
                unrepairable.length ? (
                  <ul className="flex flex-col gap-1.5">
                    <li className="text-[11px] leading-relaxed text-ink-2">
                      {t("skillImport.unfixableHint")}
                    </li>
                    {unrepairable.map((u) => (
                      <li
                        key={u.path}
                        className="flex items-start gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2"
                      >
                        <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                        <span className="min-w-0 flex-1">
                          <span className="block break-all font-mono text-[11px] text-foreground">{u.path}</span>
                          <span className="mt-0.5 block text-[11px] text-danger">{u.reason}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-xl border border-border bg-card px-3 py-6 text-center text-xs text-ink-3">
                    {t("skillImport.noUnfixable")}
                  </p>
                )
              ) : null}

              {/* Step 3 AI 修复 */}
              {step === 2 ? (
                <div className="flex flex-col gap-3">
                  <p className="text-[11px] leading-relaxed text-ink-2">
                    {t("skillImport.aiHint", { n: needsAi.length })}
                  </p>
                  {needsAi.length ? (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="w-fit"
                        disabled={aiBusy}
                        onClick={() => void runAiFix()}
                      >
                        {aiBusy ? <Loader2 className="animate-spin" /> : <Wand2 />}
                        {aiBusy ? t("skillImport.aiRunning") : t("skillImport.aiRun")}
                      </Button>
                      <ul className="flex flex-col gap-1.5">
                        {needsAi.map((c) => (
                          <li
                            key={c.originalPath}
                            className="rounded-lg border border-border bg-card px-3 py-2"
                          >
                            <span className="flex items-center gap-2">
                              {aiDone.has(c.originalPath) ? (
                                <Check className="size-3.5 shrink-0 text-success" />
                              ) : (
                                <Sparkles className="size-3.5 shrink-0 text-ink-3" />
                              )}
                              <span className="font-mono text-[11px] text-foreground">{c.fixedName}</span>
                            </span>
                            <span className="mt-1 block text-[11px] leading-relaxed text-ink-2">
                              {c.skillMdDescription.trim() || t("skillImport.aiPending")}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="rounded-xl border border-border bg-card px-3 py-6 text-center text-xs text-ink-3">
                      {t("skillImport.aiNone")}
                    </p>
                  )}
                </div>
              ) : null}

              {/* Step 4 来源确认 */}
              {step === 3 ? (
                <ul className="flex flex-col gap-2">
                  {importable
                    .filter((c) => selected.has(c.originalPath))
                    .map((c) => {
                      const s = sources[c.originalPath] ?? c.source;
                      const kind = s.kind === "custom" ? "custom" : s.kind || "manual";
                      return (
                        <li
                          key={c.originalPath}
                          className="rounded-xl border border-border bg-card px-3 py-2.5"
                        >
                          <span className="font-mono text-xs font-medium text-foreground">{c.fixedName}</span>
                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            <Select
                              value={kind}
                              onValueChange={(v) => setSource(c.originalPath, { kind: v })}
                            >
                              <SelectTrigger className="h-8 w-32 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="url">{t("skillImport.srcUrl")}</SelectItem>
                                <SelectItem value="local-path">{t("skillImport.srcLocal")}</SelectItem>
                                <SelectItem value="custom">{t("skillImport.srcCustom")}</SelectItem>
                                <SelectItem value="manual">{t("skillImport.srcManual")}</SelectItem>
                              </SelectContent>
                            </Select>
                            <Input
                              value={s.value}
                              onChange={(e) => setSource(c.originalPath, { value: e.target.value })}
                              placeholder={
                                kind === "url"
                                  ? t("skillImport.srcUrlPh")
                                  : kind === "local-path"
                                    ? t("skillImport.srcLocalPh")
                                    : t("skillImport.srcValuePh")
                              }
                              className="h-8 min-w-40 flex-1 font-mono text-xs"
                            />
                            {c.source.kind ? (
                              <span className="shrink-0 text-[10px] text-ink-3">
                                {t("skillImport.detected")}：
                                {c.source.kind === "url" && c.source.value
                                  ? c.source.value
                                  : srcKindLabel(c.source.kind)}
                              </span>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                </ul>
              ) : null}

              {/* Step 5 执行 */}
              {step === 4 ? (
                <div className="flex flex-col gap-3">
                  {running ? (
                    <>
                      <div className="flex items-center gap-2 text-[11px] text-ink-2">
                        <Loader2 className="size-3.5 animate-spin" />
                        <span>
                          {progress
                            ? `${t(`skillImport.stage_${progress.stage}`, { defaultValue: progress.stage })}（${progress.current}/${progress.total}）`
                            : t("skillImport.starting")}
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                        <div
                          className="h-full rounded-full bg-primary transition-[width] duration-200"
                          style={{
                            width: `${progress && progress.total ? Math.round((progress.current / progress.total) * 100) : 0}%`,
                          }}
                        />
                      </div>
                      {progress?.message ? (
                        <p className="break-all text-[11px] text-ink-3">{progress.message}</p>
                      ) : null}
                    </>
                  ) : result ? (
                    <ul className="flex flex-col gap-1.5">
                      {result.aborted ? (
                        <li className="rounded-lg border border-border bg-bg-subtle px-3 py-2 text-xs text-ink-2">
                          {t("skillImport.aborted")}
                        </li>
                      ) : null}
                      {result.outcomes.map((o) => (
                        <li
                          key={o.path}
                          className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2"
                        >
                          {o.ok ? (
                            <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
                          ) : (
                            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block font-mono text-[11px] text-foreground">
                              {o.dirName || o.path}
                            </span>
                            <span className="mt-0.5 block text-[11px] text-ink-2">
                              {o.ok ? o.message || t("skillImport.ok") : o.error}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <>
                      <p className="text-xs text-ink-3">{t("skillImport.ready", { n: selected.size })}</p>
                      {/* 决策 1：同名技能默认覆盖，用户可取消（取消后同名冲突记为失败） */}
                      <label className="flex w-fit cursor-pointer items-center gap-2 text-[11px] text-ink-2">
                        <input
                          type="checkbox"
                          checked={overwrite}
                          onChange={(e) => setOverwrite(e.target.checked)}
                          className="size-3.5 accent-[var(--ah-primary)]"
                        />
                        {t("skillImport.overwriteExisting")}
                      </label>
                      {/* 本次导入是否生成摘要：初值跟随全局设置，取消勾选不改全局 */}
                      <label className="flex w-fit cursor-pointer items-center gap-2 text-[11px] text-ink-2">
                        <input
                          type="checkbox"
                          checked={generateSummary}
                          onChange={(e) => setGenerateSummary(e.target.checked)}
                          className="size-3.5 accent-[var(--ah-primary)]"
                        />
                        {t("skillSummary.importToggle")}
                      </label>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </DialogBody>

        <Dialog open={!!detail} onOpenChange={(open) => { if (!open) setDetail(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{detail?.name ?? ""}</DialogTitle>
            <DialogDescription>{t("skillImport.detailHint")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="max-h-[60vh] overflow-y-auto">
            {detail && <SkillFileBrowser dirName={detail.dirName} />}
          </DialogBody>
        </DialogContent>
      </Dialog>

      <DialogFooter>
          {step > 0 && !running && !result ? (
            <Button variant="secondary" onClick={prevStep} disabled={aiBusy}>
              {t("common.back")}
            </Button>
          ) : null}
          <div className="flex-1" />
          {step === 4 ? (
            running || result ? (
              <Button variant="secondary" onClick={() => close(false)} disabled={running}>
                {t("common.close")}
              </Button>
            ) : (
              <>
                <Button variant="secondary" onClick={() => close(false)} disabled={aiBusy}>
                  {t("common.cancel")}
                </Button>
                <Button onClick={() => void run()} disabled={selected.size === 0}>
                  {t("skillImport.execute", { n: selected.size })}
                </Button>
              </>
            )
          ) : step === 1 ? (
            <>
              <Button variant="destructive" onClick={() => void doAbort()} disabled={aiBusy}>
                {t("skillImport.abort")}
              </Button>
              <Button onClick={() => setStep(2)} disabled={aiBusy || selected.size === 0}>
                {t("skillImport.continueSkip")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => close(false)} disabled={aiBusy || running}>
                {t("common.cancel")}
              </Button>
              <Button
                onClick={nextStep}
                disabled={
                  applying ||
                  aiBusy ||
                  (step === 0 && selected.size === 0 && !unrepairable.length)
                }
              >
                {step === 0 && unrepairable.length ? t("skillImport.reviewUnfixable") : t("skillImport.next")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}