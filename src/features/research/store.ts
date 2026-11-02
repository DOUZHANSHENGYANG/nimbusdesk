/**
 * 调研的任务队列：什么时候跑、跑到哪、暂停还是取消，都在这里。
 *
 * 队列放在模块级 store 里，离开页面不中断；每次状态变化把整条队列快照写进
 * `modules/research/jobs.json`（Rust 侧）。重启后照参考实现的做法，把没跑完的
 * 一律标成「已中断」——不假装续跑，也不留僵尸。
 */
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "@/stores/settings";
import { runResearch, type Channel, type Depth, type ResearchEvent, type SourceDoc } from "./run";

export type RunStatus = "queued" | "running" | "paused" | "success" | "failed" | "canceled" | "interrupted";

export interface ResearchJob {
    id: string;
    query: string;
    depth: Depth;
    channels: Channel[];
    status: RunStatus;
    step: string;
    events: ResearchEvent[];
    sources: Omit<SourceDoc, "text">[];
    claims: number;
    report: string;
    file: string;
    error: string;
    startedAt: number | null;
    finishedAt: number | null;
}

export interface SavedResearch {
    file: string;
    query: string;
    depth: string;
    channels: string[];
    createdAt: string;
    title: string;
    /** 报告里用到的来源数（Rust 从同名 .json 的 detail.sources 读） */
    sources: number;
}

/** 报告同名 .json 里的过程记录（历史报告靠它回放过程）。 */
export interface RunMeta {
    depth?: string;
    channels?: string[];
    plan?: { sub_questions?: string[]; web_queries?: string[]; social_queries?: string[]; repo_query?: string };
    sources?: { index: number; title: string; url: string; channel: string; ok: boolean; chars: number }[];
    claims?: { claim: string; source: number; verified: boolean }[];
}

const MAX_CONCURRENT = 2;
const cancelled = new Set<string>();
const paused = new Set<string>();
const resumeResolvers = new Map<string, () => void>();

const dir = () => useSettings.getState().researchRoot;
const newId = () => `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** 上次看的是哪个任务（参考实现也用 localStorage 记这个）。 */
const ACTIVE_KEY = "research-active-job";

interface ResearchState {
    jobs: ResearchJob[];
    activeId: string;
    opened: { file: string; markdown: string; meta: RunMeta | null } | null;
    history: SavedResearch[];
    hydrated: boolean;
    hydrate: () => Promise<void>;
    loadHistory: () => Promise<void>;
    start: (input: { topic: string; depth: Depth; channels: Channel[] }) => void;
    cancel: (id: string) => void;
    pause: (id: string) => void;
    resume: (id: string) => void;
    promote: (id: string) => void;
    select: (id: string) => void;
    newResearch: () => void;
    open: (file: string) => Promise<void>;
    removeOpened: () => Promise<void>;
}

const patch = (jobs: ResearchJob[], id: string, changes: Partial<ResearchJob>) =>
    jobs.map(job => job.id === id ? { ...job, ...changes } : job);

/** 重启后：进程里的任务已经没了，别把它们显示成「还在跑」。 */
function interruptUnfinished(jobs: ResearchJob[]): ResearchJob[] {
    return jobs.map(job => job.status === "running" || job.status === "queued" || job.status === "paused"
        ? { ...job, status: "interrupted" as RunStatus, step: "", finishedAt: job.finishedAt ?? Date.now() }
        : job);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** 队列快照合并成一次写：一次运行会产生几十次状态变化。 */
function saveSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        void invoke("research_jobs_save", { jobs: useResearch.getState().jobs }).catch(() => undefined);
    }, 400);
}

export const useResearch = create<ResearchState>()((set, get) => ({
    jobs: [],
    activeId: "",
    opened: null,
    history: [],
    hydrated: false,

    hydrate: async () => {
        if (get().hydrated) return;
        try {
            const saved = await invoke<ResearchJob[]>("research_jobs");
            const jobs = interruptUnfinished(saved);
            const changed = jobs.some((job, index) => job.status !== saved[index]?.status || job.step !== saved[index]?.step);
            set({ jobs, hydrated: true });
            if (changed) saveSoon();
            const savedId = localStorage.getItem(ACTIVE_KEY) ?? "";
            const target = jobs.find(job => job.id === savedId) ?? jobs.find(job => job.status === "running") ?? jobs[0];
            if (target) set({ activeId: target.id });
        } catch {
            set({ hydrated: true });
        }
        void get().loadHistory();
    },

    loadHistory: async () => {
        try {
            set({ history: await invoke<SavedResearch[]>("research_list", { dir: dir() }) });
        } catch {
            set({ history: [] });
        }
    },

    start: input => {
        const job: ResearchJob = {
            id: newId(),
            query: input.topic,
            depth: input.depth,
            channels: input.channels,
            status: "queued",
            step: "",
            events: [],
            sources: [],
            claims: 0,
            report: "",
            file: "",
            error: "",
            startedAt: null,
            finishedAt: null,
        };
        set(state => ({ jobs: [...state.jobs, job], activeId: job.id, opened: null }));
        localStorage.setItem(ACTIVE_KEY, job.id);
        saveSoon();
        pump();
    },

    cancel: id => {
        cancelled.add(id);
        // 暂停中被取消：先松开暂停闸，ensure() 才能走到「已取消」那一步
        paused.delete(id);
        resumeResolvers.get(id)?.();
        resumeResolvers.delete(id);
        const job = get().jobs.find(item => item.id === id);
        if (!job) return;
        if (job.startedAt === null || (job.status === "paused" && job.events.length === 0)) {
            // 还没开始跑：直接判掉，免得占着队列
            set(state => ({ jobs: patch(state.jobs, id, { status: "canceled", finishedAt: Date.now() }) }));
            saveSoon();
            pump();
        }
    },

    pause: id => {
        const job = get().jobs.find(item => item.id === id);
        if (!job || (job.status !== "running" && job.status !== "queued")) return;
        paused.add(id);
        set(state => ({ jobs: patch(state.jobs, id, { status: "paused" }) }));
        saveSoon();
        pump();
    },

    resume: id => {
        const job = get().jobs.find(item => item.id === id);
        if (!job || job.status !== "paused") return;
        paused.delete(id);
        resumeResolvers.get(id)?.();
        resumeResolvers.delete(id);
        set(state => ({ jobs: patch(state.jobs, id, { status: job.startedAt === null ? "queued" : "running" }) }));
        saveSoon();
        pump();
    },

    promote: id => {
        set(state => {
            const job = state.jobs.find(item => item.id === id);
            if (!job) return state;
            return { jobs: [job, ...state.jobs.filter(item => item.id !== id)] };
        });
        saveSoon();
    },

    select: id => {
        localStorage.setItem(ACTIVE_KEY, id);
        set({ activeId: id, opened: null });
    },

    newResearch: () => set({ activeId: "", opened: null }),

    open: async file => {
        try {
            const [markdown, meta] = await Promise.all([
                invoke<string>("research_read", { file, dir: dir() }),
                invoke<RunMeta>("research_meta", { file, dir: dir() }).catch(() => null),
            ]);
            set({ opened: { file, markdown, meta }, activeId: "" });
        } catch (cause) {
            set({ opened: { file, markdown: "", meta: null } });
            throw cause;
        }
    },

    removeOpened: async () => {
        const file = get().opened?.file;
        if (!file) return;
        await invoke("research_delete", { file, dir: dir() });
        set({ opened: null });
        void get().loadHistory();
    },
}));

/** 有空位就把队首的 queued 拉起来。 */
function pump() {
    const state = useResearch.getState();
    const running = state.jobs.filter(job => job.status === "running").length;
    let free = MAX_CONCURRENT - running;
    for (const job of state.jobs) {
        if (free <= 0) break;
        if (job.status !== "queued") continue;
        free--;
        void runJob(job.id);
    }
}

async function runJob(id: string) {
    const job = useResearch.getState().jobs.find(item => item.id === id);
    if (!job) return;
    useResearch.setState(state => ({
        jobs: patch(state.jobs, id, { status: "running", startedAt: Date.now(), step: "" }),
    }));
    saveSoon();
    try {
        const result = await runResearch({
            topic: job.query,
            depth: job.depth,
            channels: job.channels,
            onEvent: event => append(id, event),
            isCancelled: () => cancelled.has(id),
            isPaused: () => paused.has(id),
            waitWhilePaused: () => waitWhilePaused(id),
        });
        useResearch.setState(state => ({
            jobs: patch(state.jobs, id, {
                status: "success",
                report: result.markdown,
                file: result.file,
                finishedAt: Date.now(),
            }),
        }));
        saveSoon();
        void useResearch.getState().loadHistory();
    } catch (cause) {
        const wasCanceled = cancelled.has(id);
        const message = cause instanceof Error ? cause.message : String(cause);
        append(id, { kind: "error", message: wasCanceled ? "已取消" : message });
        useResearch.setState(state => ({
            jobs: patch(state.jobs, id, {
                status: wasCanceled ? "canceled" : "failed",
                error: wasCanceled ? "" : message,
                finishedAt: Date.now(),
            }),
        }));
        saveSoon();
    } finally {
        cancelled.delete(id);
        paused.delete(id);
        pump();
    }
}

function append(id: string, event: ResearchEvent) {
    useResearch.setState(state => {
        const job = state.jobs.find(item => item.id === id);
        if (!job) return state;
        const changes: Partial<ResearchJob> = {
            events: [...job.events, event],
            step: event.message,
        };
        if (event.kind === "fetch") changes.sources = event.sources;
        if (event.kind === "extract-total") changes.claims = event.total;
        return { jobs: patch(state.jobs, id, changes) };
    });
    saveSoon();
}

function waitWhilePaused(id: string): Promise<void> {
    if (!paused.has(id)) return Promise.resolve();
    return new Promise(resolve => {
        let timer: ReturnType<typeof setInterval>;
        const done = () => {
            clearInterval(timer);
            resumeResolvers.delete(id);
            resolve();
        };
        // 暂停期间被取消：直接放行，让流水线走到下一个 ensure 抛「已取消」
        timer = setInterval(() => { if (cancelled.has(id)) done(); }, 500);
        resumeResolvers.set(id, done);
    });
}
