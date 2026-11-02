import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { api } from "@/ahub/lib/api";
import type { SkillUpdateReport } from "@/ahub/lib/types";
import { tauriJsonStorage } from "@/lib/storage";
import { useData } from "@/ahub/stores/data";
import { i18n } from "@/lib/i18n";
import { notify } from "@/lib/notifications";

export type SkillUpdateStage =
  | "queued"
  | "checking"
  | "discovering"
  | "applying"
  | "done"
  | "rejected"
  | "failed"
  | "paused"
  | "cancelled";

export interface SkillUpdateTask {
  id: string;
  dirName: string;
  name: string;
  stage: SkillUpdateStage;
  progress: number;
  message: string;
  confidence: number;
  sourceUrl: string;
  sourceKind: string;
  candidateName: string;
  query: string;
  channels: string[];
  /** 每个渠道命中几条候选：[["skillhub", 3], ["github", 0]] */
  channelHits?: [string, number][];
  workDir: string;
  error: string;
  createdAt: string;
  updatedAt: string;
}

interface SettingsState {
  workDir: string;
  threshold: number;
  setWorkDir: (workDir: string) => void;
  setThreshold: (threshold: number) => void;
}

/** 用户目录与置信度阈值：独立持久化，任务队列本身只在当前运行期存在。 */
export const useSkillUpdateSettings = create<SettingsState>()(
  persist(
    (set) => ({
      workDir: "",
      threshold: 0.75,
      setWorkDir: (workDir) => set({ workDir }),
      setThreshold: (threshold) => set({ threshold: Math.min(0.98, Math.max(0.4, threshold)) }),
    }),
    { name: "skill-update-settings", storage: createJSONStorage(() => tauriJsonStorage), version: 1 },
  ),
);

interface QueueState {
  tasks: SkillUpdateTask[];
  centerOpen: boolean;
  openCenter: () => void;
  closeCenter: () => void;
  enqueue: (items: { dirName: string; name: string }[]) => void;
  pause: (id: string) => void;
  resume: (id: string) => void;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  clearFinished: () => void;
}

const ACTIVE: SkillUpdateStage[] = ["queued", "checking", "discovering", "applying", "paused"];

function now() {
  return new Date().toISOString();
}

function updateTask(
  set: (fn: (state: QueueState) => Partial<QueueState>) => void,
  id: string,
  patch: (task: SkillUpdateTask) => Partial<SkillUpdateTask> | null,
) {
  set((state) => ({
    tasks: state.tasks.map((task) => {
      if (task.id !== id) return task;
      const next = patch(task);
      if (!next) return task;
      return { ...task, ...next, updatedAt: now() };
    }),
  }));
}

export const useSkillUpdateQueue = create<QueueState>((set, get) => ({
  tasks: [],
  centerOpen: false,
  openCenter: () => set({ centerOpen: true }),
  closeCenter: () => set({ centerOpen: false }),
  enqueue: (items) => {
    const activeDirs = new Set(
      get()
        .tasks.filter((task) => ACTIVE.includes(task.stage))
        .map((task) => task.dirName),
    );
    const stamp = now();
    const added = items
      .filter((item) => !activeDirs.has(item.dirName))
      .map((item) => ({
        id: crypto.randomUUID(),
        dirName: item.dirName,
        name: item.name,
        stage: "queued" as const,
        progress: 0,
        message: "等待开始",
        confidence: 0,
        sourceUrl: "",
        sourceKind: "",
        candidateName: "",
        query: "",
        channels: [],
        workDir: "",
        error: "",
        createdAt: stamp,
        updatedAt: stamp,
      }));
    if (added.length) {
      set((state) => ({ tasks: [...state.tasks, ...added], centerOpen: true }));
      void drainSkillUpdates();
    }
  },
  pause: (id) => {
    updateTask(set, id, (task) =>
      task.stage === "done" || task.stage === "failed" || task.stage === "rejected" || task.stage === "cancelled"
        ? null
        : { stage: "paused", message: "已暂停（当前步骤结束后停下）" },
    );
  },
  resume: (id) => {
    updateTask(set, id, (task) => (task.stage === "paused" ? { stage: "queued", message: "已恢复" } : null));
    void drainSkillUpdates();
  },
  cancel: (id) => {
    updateTask(set, id, (task) =>
      task.stage === "done" || task.stage === "failed" || task.stage === "rejected" || task.stage === "cancelled"
        ? null
        : { stage: "cancelled", message: "已终止" },
    );
  },
  retry: (id) => {
    updateTask(set, id, (task) =>
      task.stage === "queued" || task.stage === "checking" || task.stage === "discovering" || task.stage === "applying"
        ? null
        : {
            stage: "queued",
            progress: 0,
            message: "重新排队",
            error: "",
            confidence: 0,
            sourceUrl: "",
            sourceKind: "",
            candidateName: "",
            query: "",
            channels: [],
          },
    );
    void drainSkillUpdates();
  },
  clearFinished: () =>
    set((state) => ({
      tasks: state.tasks.filter((task) => ACTIVE.includes(task.stage)),
    })),
}));

let draining = false;

/**
 * 并发上限。原来是严格串行——一个技能卡在 AI 搜源，后面全部「排队中」等到天荒地老。
 * 这些活都是网络 IO（git ls-remote / clone / AI 请求），3 路并发不会打满机器，
 * 又能让慢任务不再堵住整条队列。
 */
const MAX_PARALLEL = 3;
const STAGE_TIMEOUT_MS = 180_000;

/** 给不可取消的 invoke 套一层超时：到点先让界面失败，别让队列永远卡住。 */
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}超时（${STAGE_TIMEOUT_MS / 1000}s），已跳过这个技能`)), STAGE_TIMEOUT_MS)),
  ]);
}

function busyCount(): number {
  return useSkillUpdateQueue.getState().tasks.filter(
    (task) => task.stage === "checking" || task.stage === "discovering" || task.stage === "applying",
  ).length;
}

export async function drainSkillUpdates() {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const state = useSkillUpdateQueue.getState();
      const running = busyCount();
      if (running >= MAX_PARALLEL) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      const batch = state.tasks.filter((task) => task.stage === "queued").slice(0, MAX_PARALLEL - running);
      if (!batch.length) {
        if (running === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      await Promise.all(batch.map((task) => runTask(task.id)));
    }
  } finally {
    draining = false;
  }
}

function channelHitsOf(report: { candidates?: { channel: string }[] }): [string, number][] {
  const map = new Map<string, number>();
  for (const candidate of report.candidates ?? []) {
    map.set(candidate.channel, (map.get(candidate.channel) ?? 0) + 1);
  }
  return [...map.entries()];
}

function stopped(id: string): boolean {
  const task = useSkillUpdateQueue.getState().tasks.find((item) => item.id === id);
  return !task || task.stage === "paused" || task.stage === "cancelled";
}

function patch(
  id: string,
  next: Partial<SkillUpdateTask>,
) {
  updateTask(useSkillUpdateQueue.setState, id, (task) =>
    task.stage === "paused" || task.stage === "cancelled" ? null : next,
  );
}

function finish(id: string, stage: "done" | "rejected" | "failed", message: string, extra: Partial<SkillUpdateTask> = {}) {
  updateTask(useSkillUpdateQueue.setState, id, (task) =>
    task.stage === "cancelled" ? null : { stage, message, progress: stage === "done" ? 100 : task.progress, ...extra },
  );
  const task = useSkillUpdateQueue.getState().tasks.find((entry) => entry.id === id);
  if (!task) return;
  const title =
    stage === "done"
      ? i18n.t("notifications.skillDone", { name: task.name })
      : stage === "rejected"
        ? i18n.t("notifications.skillRejected", { name: task.name })
        : i18n.t("notifications.skillFailed", { name: task.name });
  notify({
    source: "skill",
    level: stage === "done" ? "success" : stage === "rejected" ? "warning" : "error",
    title,
    body: (extra.error as string | undefined) || message,
    dedupeKey: `skill:${task.dirName}:${stage}`,
    route: "/toolbox/skills",
    system: true,
  });
}

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fa5-]/g, "");
}

function pickGitSkill(
  skills: { path: string; name: string; description: string; repoPath?: string; subtreeSha?: string }[],
  dirName: string,
  name: string,
) {
  const target = normalize(dirName);
  const wanted = normalize(name);
  const baseName = (path: string) => normalize(path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "");
  return (
    skills.find((skill) => baseName(skill.path) === target) ??
    skills.find((skill) => normalize(skill.name) === wanted) ??
    skills.find((skill) => baseName(skill.path) === wanted)
  );
}

async function runTask(id: string) {
  const task = useSkillUpdateQueue.getState().tasks.find((item) => item.id === id);
  if (!task || task.stage !== "queued") return;
  const settings = useSkillUpdateSettings.getState();

  patch(id, { stage: "checking", progress: 8, message: "读取上游配置" });
  let probe: Awaited<ReturnType<typeof api.skillUpdateProbe>>;
  try {
    probe = await api.skillUpdateProbe(task.dirName);
  } catch (error) {
    finish(id, "failed", "读取技能失败", { error: String(error) });
    return;
  }
  if (stopped(id)) return;

  // 只有确认是 git 仓库才走 ls-remote + clone；doc/web 一律交给 discover。
  if (probe.hasUpstream && probe.mode === "git-scan") {
    patch(id, { progress: 22, message: `检查上游 ${probe.remote}` });
    let check: Awaited<ReturnType<typeof api.checkUpstream>> | null = null;
    try {
      check = await api.checkUpstream(task.dirName);
    } catch {
      // SKILL.toml 尚未接入协议时 check 会报错；仍可直接拉取 remote。
    }
    if (stopped(id)) return;
    if (check?.watched && !check.changed && check.remoteHead) {
      finish(id, "done", "已是最新上游版本", {
        confidence: 1,
        sourceUrl: probe.remote,
        sourceKind: "git",
        channels: ["git"],
      });
      return;
    }

    patch(id, { stage: "applying", progress: 52, message: "拉取上游仓库" });
    let tempDir = "";
    try {
      const fetched = await withTimeout(api.gitFetchSkills(probe.remote), "拉取上游仓库");
      tempDir = fetched.tempDir;
      if (stopped(id)) return;
      const candidate = pickGitSkill(fetched.skills, task.dirName, task.name);
      if (!candidate) throw new Error("上游仓库里找不到同名技能");
      // 覆盖前先对账：本地改过就别默默盖掉，交给用户去三选一。
      patch(id, { progress: 66, message: "核对本地改动" });
      const preview = await api.skillUpdatePreview(task.dirName, candidate.path);
      if (preview.localModified) {
        finish(id, "rejected", "本地有改动，已跳过（到技能详情里选保留哪一版）", {
          confidence: 1,
          sourceUrl: probe.remote,
          sourceKind: "git",
          candidateName: candidate.name,
          channels: ["git"],
        });
        return;
      }
      patch(id, { progress: 72, message: `应用 ${candidate.name}` });
      await api.skillUpdateApply(task.dirName, candidate.path, probe.remote, "git-scan", 1, {
        revision: fetched.revision,
        subtreePath: candidate.repoPath,
        subtreeSha: candidate.subtreeSha,
      });
      await useData.getState().loadSkills().catch(() => undefined);
      finish(id, "done", "已更新到上游最新", {
        confidence: 1,
        sourceUrl: probe.remote,
        sourceKind: "git",
        candidateName: candidate.name,
        channels: ["git"],
        channelHits: [["git", 1]],
      });
    } catch (error) {
      finish(id, "failed", "上游更新失败", { error: String(error) });
    } finally {
      if (tempDir) await api.cleanupGitTemp(tempDir).catch(() => undefined);
    }
    return;
  }

  // 没有上游，或已有网页/书籍型来源：AI 搜索 + 置信度审校。
  patch(id, {
    stage: "discovering",
    progress: 18,
    message: probe.hasUpstream ? "已有网页来源，AI 比对更新" : "AI 正在搜索上游来源",
  });
  let report: SkillUpdateReport;
  try {
    report = await withTimeout(
      api.skillUpdateDiscover(
        task.dirName,
        settings.workDir,
        settings.threshold,
        probe.hasUpstream ? probe.remote : undefined,
      ),
      "搜源",
    );
  } catch (error) {
    finish(id, "failed", "AI 搜源失败", { error: String(error) });
    return;
  }
  if (stopped(id)) return;

  if (report.status !== "candidate") {
    finish(id, "rejected", report.reason || "没有找到可信的上游来源", {
      confidence: report.confidence,
      sourceUrl: report.sourceUrl,
      sourceKind: report.sourceKind,
      query: report.query,
      channels: report.channels,
      channelHits: channelHitsOf(report),
      workDir: report.workDir,
    });
    return;
  }

  patch(id, {
    stage: "applying",
    progress: 76,
    message: `应用候选（置信度 ${(report.confidence * 100).toFixed(0)}%）`,
    confidence: report.confidence,
    sourceUrl: report.sourceUrl,
    sourceKind: report.sourceKind,
    candidateName: report.candidateName,
    query: report.query,
    channels: report.channels,
    workDir: report.workDir,
  });
  try {
    await api.skillUpdateApply(
      task.dirName,
      report.localPath,
      report.sourceUrl,
      report.mode || "web",
      report.confidence,
    );
    await useData.getState().loadSkills().catch(() => undefined);
    finish(id, "done", "AI 更新已应用", {
      confidence: report.confidence,
      sourceUrl: report.sourceUrl,
      sourceKind: report.sourceKind,
      candidateName: report.candidateName,
      channels: report.channels,
    });
  } catch (error) {
    finish(id, "failed", "应用更新失败", { error: String(error) });
  }
}
