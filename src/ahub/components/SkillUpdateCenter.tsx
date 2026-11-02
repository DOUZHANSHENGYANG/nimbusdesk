import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CirclePause,
  CirclePlay,
  CloudDownload,
  FolderOpen,
  Loader2,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Badge } from "@/ahub/components/ui/badge";
import { Button } from "@/ahub/components/ui/button";
import { Field, Input, Label } from "@/ahub/components/ui/input";
import { api } from "@/ahub/lib/api";
import { cn } from "@/ahub/lib/utils";
import {
  useSkillUpdateQueue,
  useSkillUpdateSettings,
  type SkillUpdateStage,
  type SkillUpdateTask,
} from "@/ahub/stores/skill-update";

const STAGE_KEY: Record<SkillUpdateStage, string> = {
  queued: "skills.skillUpdate.stageQueued",
  checking: "skills.skillUpdate.stageChecking",
  discovering: "skills.skillUpdate.stageDiscovering",
  applying: "skills.skillUpdate.stageApplying",
  done: "skills.skillUpdate.stageDone",
  rejected: "skills.skillUpdate.stageRejected",
  failed: "skills.skillUpdate.stageFailed",
  paused: "skills.skillUpdate.stagePaused",
  cancelled: "skills.skillUpdate.stageCancelled",
};

const ACTIVE: SkillUpdateStage[] = ["queued", "checking", "discovering", "applying", "paused"];

const CHANNEL_LABEL: Record<string, string> = {
  doc: "本地文档",
  wellknown: "well-known",
  deepskill: "DeepSkill",
  github: "GitHub",
  git: "Git",
  web: "Web",
};

function stageTone(stage: SkillUpdateStage) {
  if (stage === "done") return "success" as const;
  if (stage === "failed") return "danger" as const;
  if (stage === "rejected") return "warning" as const;
  if (stage === "paused") return "muted" as const;
  if (stage === "cancelled") return "muted" as const;
  return "info" as const;
}

function StageIcon({ task }: { task: SkillUpdateTask }) {
  if (task.stage === "done") return <CheckCircle2 className="size-4 text-success" />;
  if (task.stage === "failed") return <AlertTriangle className="size-4 text-danger" />;
  if (task.stage === "rejected") return <XCircle className="size-4 text-warning" />;
  if (task.stage === "paused") return <CirclePause className="size-4 text-ink-3" />;
  if (task.stage === "cancelled") return <Square className="size-4 text-ink-3" />;
  if (task.stage === "queued") return <Sparkles className="size-4 text-ink-3" />;
  return <Loader2 className="size-4 animate-spin text-primary" />;
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-[11px]">
      <span className="shrink-0 text-ink-3">{label}</span>
      <span className="truncate font-mono text-ink-2" title={value}>
        {value}
      </span>
    </div>
  );
}

/** 技能更新中心：右侧抽屉。设置与队列分开，任务卡片留白足够。 */
export function SkillUpdateCenter() {
  const { t } = useTranslation();
  const { tasks, centerOpen, closeCenter, pause, resume, cancel, retry, clearFinished } =
    useSkillUpdateQueue();
  const { workDir, threshold, setWorkDir, setThreshold } = useSkillUpdateSettings();
  const [aiReady, setAiReady] = useState<boolean | null>(null), [historyRange, setHistoryRange] = useState<"today" | "7d" | "all">("today");

  // 只问后端：默认提供商可能来自设置页，也可能来自云台的 ai-providers 桥接，
  // 前端自己看 aiProviders 会把已配置的情况误报成「没有默认 AI 提供商」。
  useEffect(() => {
    if (!centerOpen) return;
    let alive = true;
    void api
      .skillUpdateAiReady()
      .then((ready) => alive && setAiReady(ready))
      .catch(() => alive && setAiReady(null));
    return () => {
      alive = false;
    };
  }, [centerOpen]);

  if (!centerOpen) return null;

  const active = tasks.filter((task) => ACTIVE.includes(task.stage)).length;
  const finished = tasks.length - active;
  // 最新的排最前；完成的单独按时间段筛，不再和进行中的混在一起
  const sorted = [...tasks].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const runningTasks = sorted.filter((task) => ACTIVE.includes(task.stage));
  const historyTasks = sorted.filter((task) => !ACTIVE.includes(task.stage));
  const cutoff = historyRange === "today"
    ? new Date(new Date().setHours(0, 0, 0, 0)).toISOString()
    : historyRange === "7d"
      ? new Date(Date.now() - 7 * 86_400_000).toISOString()
      : "";
  const visibleTasks = [...runningTasks, ...historyTasks.filter((task) => !cutoff || (task.createdAt ?? "") >= cutoff)];

  const pickWorkDir = async () => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: t("skills.skillUpdate.pickWorkDir"),
    });
    if (typeof picked === "string" && picked) setWorkDir(picked);
  };

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" onClick={closeCenter} />

      <aside className="absolute inset-y-0 right-0 flex w-[min(600px,94vw)] flex-col border-l border-border bg-card text-foreground shadow-2xl">
        <header className="flex items-start gap-3 border-b border-border px-6 py-5">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <CloudDownload className="size-4 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold">{t("skills.skillUpdate.title")}</h2>
              {active > 0 ? (
                <Badge variant="info">{t("skills.skillUpdate.activeCount", { n: active })}</Badge>
              ) : null}
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
              {t("skills.skillUpdate.subtitle")}
            </p>
          </div>
          <Button variant="ghost" size="sm" className="-mr-1 size-8 p-0" onClick={closeCenter}>
            <X className="size-4" />
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="space-y-3">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">
              {t("skills.skillUpdate.sectionSetup")}
            </h3>

            <div className="space-y-5 rounded-xl border border-border/70 bg-surface/30 p-5">
              <Field label={t("skills.skillUpdate.workDir")}>
                <div className="flex gap-2">
                  <Input
                    value={workDir}
                    onChange={(event) => setWorkDir(event.target.value)}
                    placeholder={t("skills.skillUpdate.workDirPlaceholder")}
                    className="h-9 bg-bg-subtle font-mono text-[11px]"
                  />
                  <Button size="sm" variant="secondary" className="h-9 shrink-0 px-3" onClick={() => void pickWorkDir()}>
                    <FolderOpen className="size-3.5" />
                    {t("skills.skillUpdate.pick")}
                  </Button>
                </div>
              </Field>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between">
                  <Label>{t("skills.skillUpdate.thresholdLabel")}</Label>
                  <span className="text-[15px] font-semibold tabular-nums text-foreground">
                    {Math.round(threshold * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0.4}
                  max={0.95}
                  step={0.01}
                  value={threshold}
                  onChange={(event) => setThreshold(Number(event.target.value))}
                  className="range-input mt-0.5"
                />
                <div className="flex justify-between text-[10.5px] text-ink-3">
                  <span>{t("skills.skillUpdate.thresholdLoose")}</span>
                  <span>{t("skills.skillUpdate.thresholdStrict")}</span>
                </div>
              </div>

              <p className="border-t border-border/60 pt-4 text-[11px] leading-relaxed text-ink-3">
                {t("skills.skillUpdate.hint")}
              </p>

              {aiReady === false ? (
                <div className="flex gap-2 rounded-lg bg-warning/10 p-3">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  <p className="text-[11px] leading-relaxed text-warning">{t("skills.skillUpdate.aiMissing")}</p>
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-8 space-y-3">
            <div className="flex items-baseline justify-between">
              <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-3">
                {t("skills.skillUpdate.sectionQueue")}
              </h3>
              {tasks.length > 0 ? (
                <div className="flex items-center gap-2">
                  {historyTasks.length > 0 ? (
                    <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-0.5">
                      {([["today", t("skills.skillUpdate.rangeToday")], ["7d", t("skills.skillUpdate.range7d")], ["all", t("skills.skillUpdate.rangeAll")]] as const).map(([key, label]) => (
                        <button key={key} type="button" onClick={() => setHistoryRange(key)}
                          className={cn("rounded-md px-1.5 py-0.5 text-[10px] transition-colors", historyRange === key ? "bg-background text-foreground shadow-sm" : "text-ink-3 hover:text-foreground")}>
                          {label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <span className="text-[10.5px] tabular-nums text-ink-3">
                    {t("skills.skillUpdate.queueSummary", { done: finished, total: tasks.length })}
                  </span>
                </div>
              ) : null}
            </div>

            {visibleTasks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border py-14 text-center">
                <CloudDownload className="mx-auto size-7 text-ink-3" />
                <p className="mt-3 text-[11.5px] text-ink-3">{t("skills.skillUpdate.empty")}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {visibleTasks.map((task) => {
                  const running =
                    task.stage === "checking" || task.stage === "discovering" || task.stage === "applying";
                  const canStop = ACTIVE.includes(task.stage);
                  return (
                    <article
                      key={task.id}
                      className={cn(
                        "rounded-xl border p-4 transition-colors",
                        task.stage === "failed"
                          ? "border-danger/40 bg-danger/5"
                          : task.stage === "rejected"
                            ? "border-warning/40 bg-warning/5"
                            : "border-border/70 bg-surface/20",
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 shrink-0">
                          <StageIcon task={task} />
                        </span>

                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-[12.5px] font-medium">{task.name}</span>
                            <Badge variant={stageTone(task.stage)}>{t(STAGE_KEY[task.stage])}</Badge>
                            {task.confidence > 0 ? (
                              <span className="text-[10.5px] tabular-nums text-ink-3">
                                {t("skills.skillUpdate.confidence", { n: Math.round(task.confidence * 100) })}
                              </span>
                            ) : null}
                          </div>

                          {task.error || task.message ? (
                            <p
                              className={cn(
                                "text-[11.5px] leading-relaxed",
                                task.stage === "failed" ? "text-danger" : "text-ink-2",
                              )}
                            >
                              {task.error || task.message}
                            </p>
                          ) : null}

                          <div className="space-y-1">
                            {task.sourceUrl ? <Meta label="上游" value={task.sourceUrl} /> : null}
                            {task.query ? <Meta label={t("skills.skillUpdate.queryShort")} value={task.query} /> : null}
                            {task.channels.length > 0 ? (
                              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                                {task.channels.map((channel) => {
                                  const hits = task.channelHits?.find(([key]) => key === channel)?.[1];
                                  const zero = hits === 0;
                                  return (
                                    <span
                                      key={channel}
                                      title={zero ? t("skills.skillUpdate.channelEmpty") : undefined}
                                      className={cn(
                                        "rounded-md px-1.5 py-0.5 text-[10px] tabular-nums",
                                        zero ? "bg-muted/40 text-ink-3/60 line-through" : "bg-muted text-ink-2",
                                      )}
                                    >
                                      {CHANNEL_LABEL[channel] ?? channel}
                                      {hits === undefined ? "" : ` ${hits}`}
                                    </span>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>

                          <div className="h-1 overflow-hidden rounded-full bg-border/60">
                            <div
                              className="h-full rounded-full bg-primary transition-[width] duration-500"
                              style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }}
                            />
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-0.5">
                          {running ? (
                            <Button size="sm" variant="ghost" className="size-7 p-0" onClick={() => pause(task.id)}>
                              <CirclePause className="size-3.5" />
                            </Button>
                          ) : null}
                          {task.stage === "paused" ? (
                            <Button size="sm" variant="ghost" className="size-7 p-0" onClick={() => resume(task.id)}>
                              <CirclePlay className="size-3.5" />
                            </Button>
                          ) : null}
                          {canStop ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="size-7 p-0 text-danger"
                              onClick={() => cancel(task.id)}
                            >
                              <Square className="size-3.5" />
                            </Button>
                          ) : null}
                          {!ACTIVE.includes(task.stage) ? (
                            <Button size="sm" variant="ghost" className="size-7 p-0" onClick={() => retry(task.id)}>
                              <RefreshCw className="size-3.5" />
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
          <div>
            {finished > 0 ? (
              <Button variant="ghost" size="sm" onClick={clearFinished}>
                <Trash2 className="size-3.5" />
                {t("skills.skillUpdate.clearFinished", { n: finished })}
              </Button>
            ) : null}
          </div>
          <Button variant="secondary" size="sm" onClick={closeCenter}>
            {t("common.close")}
          </Button>
        </footer>
      </aside>
    </div>
  );
}

/** 全局更新任务悬浮条：离开技能页也能看见进行中的任务，点开即抽屉。 */
export function SkillUpdateDock() {
  const { t } = useTranslation();
  const { tasks, openCenter } = useSkillUpdateQueue();
  const active = tasks.filter((task) => ACTIVE.includes(task.stage)).length;
  const running = tasks.some(
    (task) => task.stage === "checking" || task.stage === "discovering" || task.stage === "applying",
  );

  return (
    <>
      {tasks.length > 0 ? (
        <button
          type="button"
          onClick={openCenter}
          className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border border-border bg-card px-3 py-2 text-[11px] text-foreground shadow-lg transition-colors hover:bg-muted"
          title={t("skills.skillUpdate.open")}
        >
          {running ? <Loader2 className="size-3.5 animate-spin text-primary" /> : <CloudDownload className="size-3.5 text-primary" />}
          <span>{active > 0 ? t("skills.skillUpdate.dockActive", { n: active }) : t("skills.skillUpdate.dockDone")}</span>
        </button>
      ) : null}
      <SkillUpdateCenter />
    </>
  );
}
