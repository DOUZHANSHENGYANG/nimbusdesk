import { create } from "zustand";
import { api } from "@/ahub/lib/api";

export type AiJobKind = "tags" | "summary";
export type AiJobStage = "queued" | "running" | "done" | "failed";

export interface AiJob {
  id: string;
  kind: AiJobKind;
  dirName: string;
  name: string;
  description: string;
  stage: AiJobStage;
  error?: string;
}

interface Applier {
  applyTags?: (dirName: string, tags: string[]) => Promise<void>;
  reload?: () => void | Promise<void>;
}

interface AiJobsState extends Applier {
  jobs: AiJob[];
  configure(patch: Applier): void;
  enqueueTags(items: { dirName: string; name: string; description: string }[]): void;
  enqueueSummaries(items: { dirName: string; name: string; description: string }[]): void;
  /** 导入后的一条龙：接入协议 → 打标签 → 生成摘要 → 交给更新队列修上游 */
  enqueuePipeline(items: { dirName: string; name: string; description: string }[]): void;
  clearFinished(): void;
}

const make = (kind: AiJobKind, items: { dirName: string; name: string; description: string }[]): AiJob[] =>
  items.map((item) => ({ ...item, id: crypto.randomUUID(), kind, stage: "queued" as const }));

/**
 * AI 任务队列（标签 / 摘要）。
 *
 * 放在 store 里而不是页面 state：切走页面、换标签页、甚至关掉详情，
 * 任务都还在跑。页面只负责把「写标签 / 重新加载」这两个能力注册进来。
 */
export const useAiJobs = create<AiJobsState>((set) => ({
  jobs: [],
  configure: (patch) => set(patch),
  enqueueTags: (items) => {
    if (!items.length) return;
    set((state) => ({ jobs: [...state.jobs, ...make("tags", items)] }));
    void pump();
  },
  enqueueSummaries: (items) => {
    if (!items.length) return;
    set((state) => ({ jobs: [...state.jobs, ...make("summary", items)] }));
    void pump();
  },
  enqueuePipeline: (items) => {
    if (!items.length) return;
    void (async () => {
      // 1. 接入协议管理（无 AI，快）：生成 SKILL.toml，已存在就跳过
      for (const item of items) {
        try {
          await api.ensureSkillProtocol(item.dirName);
        } catch {
          /* 已接入或该技能不适合协议，都不该拦住后面的步骤 */
        }
      }
      // 2. 标签 + 3. 摘要：进队列逐个跑
      useAiJobs.getState().enqueueTags(items);
      useAiJobs.getState().enqueueSummaries(items);
      // 4. 上游：交给更新队列，没上游的会走本地文档 / well-known 溯源
      try {
        const { useSkillUpdateQueue } = await import("@/ahub/stores/skill-update");
        useSkillUpdateQueue.getState().enqueue(items.map((item) => ({ dirName: item.dirName, name: item.name })));
      } catch {
        /* 更新队列不可用时，前三步照常完成 */
      }
    })();
  },
  clearFinished: () => set((state) => ({ jobs: state.jobs.filter((job) => job.stage === "queued" || job.stage === "running") })),
}));

function patch(id: string, next: Partial<AiJob>) {
  useAiJobs.setState((state) => ({ jobs: state.jobs.map((job) => (job.id === id ? { ...job, ...next } : job)) }));
}

let pumping = false;

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const job = useAiJobs.getState().jobs.find((entry) => entry.stage === "queued");
      if (!job) break;
      patch(job.id, { stage: "running" });
      try {
        if (job.kind === "tags") {
          const tags = await api.aiSuggestTags(job.name, job.description);
          // 标签宜少不宜多：后端已按「不同维度」去重，这里再兜一层上限
          const picked = tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 4);
          if (picked.length) await useAiJobs.getState().applyTags?.(job.dirName, picked);
        } else {
          await api.skillGenerateSummary(job.dirName);
        }
        patch(job.id, { stage: "done" });
      } catch (error) {
        patch(job.id, { stage: "failed", error: String(error) });
      }
      await useAiJobs.getState().reload?.();
    }
  } finally {
    pumping = false;
  }
}
