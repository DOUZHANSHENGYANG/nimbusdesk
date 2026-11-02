import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    AlertTriangle, ArrowUpToLine, Clock, FileSearch, FileText, FolderGit2, Globe, History,
    Loader2, MessageSquare, Pause, Play, Plus, Sparkles, Waypoints, XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useModal } from "@/components/shell/modal-host";
import { cn } from "@/lib/utils";
import { CHANNELS, DEPTHS, type Channel, type Depth, type ResearchEvent } from "./run";
import { useResearch, type ResearchJob, type RunStatus } from "./store";
import { Reasoning, Response, Sources, TaskList, Tool, type SourceItem, type TaskItem, type TaskStatus } from "./components";

const CHANNEL_LABEL: Record<string, string> = {
    web: "research.channelWeb",
    "cn-social": "research.channelCn",
    global: "research.channelGlobal",
    repo: "research.channelRepo",
};

const STATUS_LABEL: Record<RunStatus, string> = {
    queued: "research.statusQueued",
    running: "research.statusRunning",
    paused: "research.statusPaused",
    success: "research.statusSuccess",
    failed: "research.statusFailed",
    canceled: "research.statusCanceled",
    interrupted: "research.statusInterrupted",
};

const DOT: Record<RunStatus, string> = {
    queued: "bg-info",
    running: "bg-brand animate-pulse",
    paused: "bg-warning",
    success: "bg-success",
    failed: "bg-destructive",
    canceled: "bg-destructive/60",
    interrupted: "bg-warning",
};

const PHASES = ["plan", "search", "fetch", "extract", "synthesize"] as const;

function elapsed(job: ResearchJob): string {
    const end = job.finishedAt ?? (job.startedAt ? Date.now() : null);
    if (!job.startedAt || end === null) return "";
    const seconds = Math.max(0, (end - job.startedAt) / 1000);
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

/** 五个阶段的完成情况：看事件走到哪、最终成没成。 */
function buildPhases(events: ResearchEvent[], status: RunStatus, label: (key: string) => string): TaskItem[] {
    const kinds: string[] = events.map(event => event.kind);
    const last = kinds[kinds.length - 1];
    const running = status === "running";
    const failed = status === "failed" || status === "canceled";
    const searchDone = events.some(event => event.kind === "search" && event.status === "done");
    const fetchEvent = events.find(event => event.kind === "fetch");
    const claimsEvent = [...events].reverse().find(event => event.kind === "extract-total");
    const planEvent = events.find(event => event.kind === "plan");
    const phase = (done: boolean, active: boolean, error = false): TaskStatus =>
        error ? "error" : done ? "done" : active ? "running" : "pending";
    const metas: Record<string, string | undefined> = {
        plan: planEvent?.kind === "plan" ? String(planEvent.plan.sub_questions.length) : undefined,
        search: searchDone ? String(events.filter(event => event.kind === "search").reduce((sum, event) => sum + (event.kind === "search" ? event.count : 0), 0)) : undefined,
        fetch: fetchEvent?.kind === "fetch" ? String(fetchEvent.sources.length) : undefined,
        extract: claimsEvent?.kind === "extract-total" ? String(claimsEvent.total) : undefined,
    };
    const statuses: Record<string, TaskStatus> = {
        plan: phase(Boolean(planEvent), running && last === "plan"),
        search: phase(searchDone, running && last === "search"),
        fetch: phase(Boolean(fetchEvent), running && last === "fetch"),
        extract: phase(Boolean(claimsEvent), running && last === "extract"),
        synthesize: phase(status === "success", running && (last === "synthesize" || last === "save"), failed && last === "error"),
    };
    return PHASES.map(id => ({
        id,
        label: label(`research.phase${id[0].toUpperCase()}${id.slice(1)}`),
        desc: label(`research.phase${id[0].toUpperCase()}${id.slice(1)}Desc`),
        status: statuses[id],
        meta: metas[id],
    }));
}

export function ResearchPage() {
    const { t } = useTranslation();
    const { confirm } = useModal();
    const jobs = useResearch(state => state.jobs);
    const activeId = useResearch(state => state.activeId);
    const opened = useResearch(state => state.opened);
    const history = useResearch(state => state.history);
    const start = useResearch(state => state.start);
    const cancel = useResearch(state => state.cancel);
    const pause = useResearch(state => state.pause);
    const resume = useResearch(state => state.resume);
    const promote = useResearch(state => state.promote);
    const select = useResearch(state => state.select);
    const newResearch = useResearch(state => state.newResearch);
    const open = useResearch(state => state.open);
    const [topic, setTopic] = useState("");
    const [depth, setDepth] = useState<Depth>("standard");
    const [channels, setChannels] = useState<Channel[]>(["web", "cn-social", "global", "repo"]);
    const [error, setError] = useState("");
    const [, tick] = useState(0);

    useEffect(() => { void useResearch.getState().loadHistory(); }, []);
    const running = jobs.some(job => job.status === "running");
    useEffect(() => {
        if (!running) return;
        const timer = setInterval(() => tick(value => value + 1), 500);
        return () => clearInterval(timer);
    }, [running]);

    const job = jobs.find(item => item.id === activeId) ?? null;
    const phases = useMemo(() => (job ? buildPhases(job.events, job.status, t) : []), [job, t]);
    const startJob = () => {
        if (topic.trim().length < 2) { setError(t("research.needQuery")); return; }
        if (!channels.length) { setError(t("research.needChannel")); return; }
        setError("");
        start({ topic: topic.trim(), depth, channels });
        setTopic("");
    };
    const toggleChannel = (channel: Channel) =>
        setChannels(current => current.includes(channel) ? current.filter(item => item !== channel) : [...current, channel]);
    const hasConversation = Boolean(job || opened);
    const runningCount = jobs.filter(item => item.status === "running").length;
    const channelLabel = (channel: string) => t(CHANNEL_LABEL[channel] ?? "research.channelWeb");
    const sourcesOf = (items: Omit<SourceItem, "index">[] | SourceItem[]): SourceItem[] => items as SourceItem[];

    return <div className="flex h-full min-h-0 flex-col workbench-ui">
        <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-4 p-4 md:p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h1 className="inline-flex items-center gap-2 text-[15px] font-bold text-foreground"><FileSearch className="size-4 text-brand"/>{t("research.title")}</h1>
                        <p className="mt-1 text-xs text-muted-foreground">{t("research.subtitle")}</p>
                    </div>
                    <div className="flex items-center gap-2">
                        {job && <span className="hidden items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground sm:flex">
                            <Clock className="size-3"/>{elapsed(job)}
                            <span className="mx-1 text-border">|</span>
                            {t("research.metaSummary", { sources: job.sources.length, claims: job.claims })}
                        </span>}
                        <Button size="sm" variant="outline" onClick={newResearch}><Plus className="size-3.5"/>{t("research.newJob")}</Button>
                    </div>
                </div>

                <div className="space-y-3 rounded-xl border border-border bg-card p-4">
                    <textarea value={topic} rows={2} placeholder={t("research.topicHint")} aria-label={t("research.topic")}
                        onChange={event => setTopic(event.target.value)}
                        onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") startJob(); }}
                        className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"/>
                    <div className="flex flex-wrap items-center gap-3">
                        <div className="inline-flex items-center rounded-lg border border-border p-0.5" role="group" aria-label={t("research.depth")}>
                            {(Object.keys(DEPTHS) as Depth[]).map(item => <button key={item} type="button" aria-pressed={depth === item} onClick={() => setDepth(item)}
                                className={cn("rounded-md px-2 py-1 text-[11px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    depth === item ? "bg-brand/15 text-foreground" : "text-muted-foreground hover:text-foreground")}>
                                {t(`research.depth${item[0].toUpperCase()}${item.slice(1)}`)}
                            </button>)}
                        </div>
                        {CHANNELS.map(channel => <label key={channel} className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
                            <input type="checkbox" className="size-3 accent-[var(--brand)]" checked={channels.includes(channel)} onChange={() => toggleChannel(channel)}/>
                            {t(CHANNEL_LABEL[channel])}
                        </label>)}
                        <Button size="sm" className="ml-auto" onClick={startJob}><Sparkles className="size-3.5"/>{t("research.start")}</Button>
                    </div>
                    {error && <p className="text-[11px] text-destructive">{error}</p>}
                </div>

                <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
                    <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card" aria-label={t("research.record")}>
                        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
                            <span className="text-xs font-bold text-foreground">{t("research.record")}</span>
                            {job && <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium",
                                job.status === "running" ? "bg-brand/10 text-brand"
                                    : job.status === "success" ? "bg-success/10 text-success"
                                        : job.status === "paused" ? "bg-warning/10 text-warning"
                                            : job.status === "queued" ? "bg-info/10 text-info"
                                                : "bg-destructive/10 text-destructive")}>
                                {t(STATUS_LABEL[job.status])}
                            </span>}
                            {job && (job.status === "running" || job.status === "queued") && <span className="max-w-[280px] truncate text-[11px] text-muted-foreground">{job.step}</span>}
                            {job?.status === "running" && <button type="button"
                                onClick={() => { void confirm({ title: t("research.cancelConfirm"), description: job.query }).then(ok => { if (ok) cancel(job.id); }); }}
                                className="ml-auto inline-flex items-center gap-1 text-[11px] text-destructive hover:opacity-80"><XCircle className="size-3"/>{t("research.cancel")}</button>}
                            {job?.file && <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">{job.file}</span>}
                            {!job && opened && <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">{opened.file}</span>}
                        </div>

                        <div className="space-y-3 px-4 py-3">
                            {!hasConversation && <div className="flex flex-col items-center justify-center py-14 text-center">
                                <div className="inline-flex size-11 items-center justify-center rounded-2xl bg-brand/10 text-brand"><FileSearch className="size-5"/></div>
                                <p className="mt-3 text-[12px] font-semibold text-foreground">{t("research.emptyTitle")}</p>
                                <p className="mt-1 max-w-[340px] text-[11px] leading-5 text-muted-foreground">{t("research.emptyBody")}</p>
                            </div>}

                            {job && <div className="flex justify-end">
                                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand px-3.5 py-2 text-primary-foreground">
                                    <p className="whitespace-pre-wrap text-[12px] leading-5">{job.query}</p>
                                    <p className="mt-1 font-mono text-[10px] text-primary-foreground/70">{job.depth} · {job.channels.map(channel => t(CHANNEL_LABEL[channel])).join(" / ")}</p>
                                </div>
                            </div>}

                            {job && <div className="rounded-xl border border-border px-3 py-2"><TaskList items={phases}/></div>}

                            {job && job.events.length > 0 && <Reasoning
                                title={t(job.status === "running" ? "research.processLive" : "research.process")}
                                meta={`${job.events.length} ${t("research.steps")} · ${elapsed(job)}`}
                                running={job.status === "running"}>
                                <Process job={job} channelLabel={channelLabel}/>
                            </Reasoning>}

                            {job?.report && <Response markdown={job.report} title={job.file}/>}
                            {job?.report && <Sources items={sourcesOf(job.sources)} title={t("research.sourcesTitle")} channelLabel={channelLabel} summaryLabel={t("research.summaryOnly")}/>}
                            {job && !job.report && job.status !== "running" && job.status !== "queued" && job.status !== "paused"
                                && <p className="text-[11px] text-muted-foreground">{t("research.noReport")}</p>}

                            {opened?.markdown && <Response markdown={opened.markdown} title={opened.file}/>}
                            {opened?.markdown && <Sources items={opened.meta?.sources ?? []} title={t("research.sourcesTitle")} channelLabel={channelLabel} summaryLabel={t("research.summaryOnly")}/>}
                        </div>
                    </section>

                    <div className="space-y-4 self-start">
                        <section className="rounded-xl border border-border bg-card p-3" aria-label={t("research.jobs")}>
                            <div className="mb-2 inline-flex items-center gap-1.5 text-xs font-bold text-foreground">
                                <Loader2 className={cn("size-3.5 text-muted-foreground", running && "animate-spin")}/>{t("research.jobs")}
                                <span className="text-[10px] font-normal tabular-nums text-muted-foreground">{t("research.jobsRunning", { running: runningCount, total: jobs.length })}</span>
                            </div>
                            {jobs.length === 0 ? <p className="text-[11px] text-muted-foreground">{t("research.noJobs")}</p> : <ul className="space-y-1">
                                {jobs.map(item => <li key={item.id} className={cn("flex items-start gap-1 rounded-lg px-1.5 py-1.5 hover:bg-accent/60", activeId === item.id && "bg-brand/10")}>
                                    <button type="button" onClick={() => select(item.id)} className="min-w-0 flex-1 text-left">
                                        <span className="flex items-center gap-1"><span className={cn("size-1.5 shrink-0 rounded-full", DOT[item.status])}/>
                                            <span className={cn("truncate text-[11px] text-foreground", activeId === item.id && "font-medium")}>{item.query}</span></span>
                                        <span className="block truncate pl-2.5 font-mono text-[10px] text-muted-foreground">{t(STATUS_LABEL[item.status])} · {item.step || "—"} · {elapsed(item)}</span>
                                    </button>
                                    {(item.status === "queued" || item.status === "paused") && <div className="flex shrink-0 flex-col gap-0.5">
                                        <button type="button" title={t("research.promote")} aria-label={t("research.promote")} onClick={() => promote(item.id)} className="rounded p-0.5 text-muted-foreground hover:text-brand"><ArrowUpToLine className="size-3"/></button>
                                        <button type="button" title={t(item.status === "paused" ? "research.resume" : "research.pause")} aria-label={t(item.status === "paused" ? "research.resume" : "research.pause")} onClick={() => item.status === "paused" ? resume(item.id) : pause(item.id)} className="rounded p-0.5 text-muted-foreground hover:text-warning">{item.status === "paused" ? <Play className="size-3"/> : <Pause className="size-3"/>}</button>
                                    </div>}
                                </li>)}
                            </ul>}
                        </section>

                        <section className="rounded-xl border border-border bg-card p-3" aria-label={t("research.history")}>
                            <div className="mb-2 inline-flex items-center gap-1.5 text-xs font-bold text-foreground"><History className="size-3.5 text-muted-foreground"/>{t("research.history")}</div>
                            {history.length === 0 ? <p className="text-[11px] text-muted-foreground">{t("research.noReports")}</p> : <ul className="space-y-1">
                                {history.slice(0, 12).map(item => <li key={item.file}>
                                    <button type="button" onClick={() => void open(item.file)} className={cn("w-full rounded-lg px-1.5 py-1.5 text-left hover:bg-accent/60", opened?.file === item.file && "bg-brand/10")}>
                                        <span className="flex items-start gap-1"><FileText className="mt-0.5 size-3 shrink-0 text-muted-foreground"/>
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-[11px] text-foreground">{item.title || item.query}</span>
                                                <span className="block font-mono text-[10px] text-muted-foreground">{item.createdAt.slice(0, 16).replace("T", " ")} · {t("research.sourceCount", { count: item.sources })}</span>
                                            </span></span>
                                    </button>
                                </li>)}
                            </ul>}
                        </section>
                    </div>
                </div>
            </div>
        </ScrollArea>
    </div>;
}

/** 过程：规划子问题、各渠道检索（带前几条链接）、抓正文、抽证据、收尾。 */
function Process({ job, channelLabel }: { job: ResearchJob; channelLabel: (channel: string) => string }) {
    const { t } = useTranslation();
    const events = job.events;
    const plan = events.find((event): event is Extract<ResearchEvent, { kind: "plan" }> => event.kind === "plan");
    const searches = useMemo(() => {
        const map = new Map<string, Extract<ResearchEvent, { kind: "search" }>>();
        for (const event of events) if (event.kind === "search") map.set(event.channel, event);
        return [...map.values()];
    }, [events]);
    const fetch = [...events].reverse().find((event): event is Extract<ResearchEvent, { kind: "fetch" }> => event.kind === "fetch");
    const extracts = events.filter((event): event is Extract<ResearchEvent, { kind: "extract" }> => event.kind === "extract");
    const total = [...events].reverse().find((event): event is Extract<ResearchEvent, { kind: "extract-total" }> => event.kind === "extract-total");
    const done = events.find((event): event is Extract<ResearchEvent, { kind: "done" }> => event.kind === "done");
    const failure = events.find((event): event is Extract<ResearchEvent, { kind: "error" }> => event.kind === "error");

    return <>
        {plan && <Tool icon={<Sparkles className="size-3"/>} title={t("research.phasePlan")} subtitle={plan.message} badge={`${plan.plan.sub_questions.length} ${t("research.subQuestions")}`} defaultOpen>
            <div className="flex flex-wrap gap-1 pt-1.5">{plan.plan.sub_questions.map(item => <span key={item} className="rounded bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand">{item}</span>)}</div>
            {!!plan.plan.web_queries.length && <p className="pt-1 text-[10px] text-muted-foreground"><span className="font-mono">queries:</span> {plan.plan.web_queries.join(" · ")}</p>}
        </Tool>}

        {searches.map(event => <Tool key={event.channel}
            icon={event.channel === "web" ? <Globe className="size-3"/> : event.channel === "repo" ? <FolderGit2 className="size-3"/> : event.channel === "global" ? <Waypoints className="size-3"/> : <MessageSquare className="size-3"/>}
            title={`${t("research.searchTitle")} · ${channelLabel(event.channel)}`}
            subtitle={event.message}
            badge={event.status === "error" ? t("research.failed") : `${event.count}`}
            status={event.status === "error" ? "error" : event.status === "running" ? "running" : "done"}>
            {!!event.items.length && <ul className="space-y-0.5 pt-1.5">{event.items.map(item => <li key={item.url} className="truncate text-[10px]">
                <a href={item.url} target="_blank" rel="noreferrer noopener" className="text-muted-foreground hover:text-brand">{item.title}</a>
            </li>)}</ul>}
        </Tool>)}

        {fetch && <Tool icon={<FileText className="size-3"/>} title={t("research.phaseFetch")} subtitle={fetch.message} badge={`${fetch.sources.length}`}>
            <ul className="space-y-0.5 pt-1.5">{fetch.sources.map(source => <li key={source.url} className="flex items-center gap-1.5 text-[10px]">
                <span className="w-4 shrink-0 text-center font-mono text-muted-foreground">{source.index}</span>
                <span className="truncate text-muted-foreground">{source.title}</span>
                <span className="ml-auto shrink-0 font-mono text-muted-foreground">{source.chars}c</span>
                <span className={source.ok ? "text-success" : "text-warning"}>{source.ok ? "OK" : t("research.summaryOnly")}</span>
            </li>)}</ul>
        </Tool>}

        {!!extracts.length && <Tool icon={<FileSearch className="size-3"/>} title={t("research.phaseExtract")}
            subtitle={total?.message ?? `${extracts.length}`} badge={total ? `${total.total}` : undefined}
            status={job.status === "running" && !total ? "running" : "done"}>
            <ul className="space-y-0.5 pt-1.5">{extracts.map((event, index) => <li key={`${event.source}-${index}`} className="flex items-center gap-1.5 text-[10px]">
                <span className="w-4 shrink-0 text-center font-mono text-muted-foreground">{event.source}</span>
                <span className="truncate text-muted-foreground">{event.title}</span>
                <span className="ml-auto shrink-0 font-mono text-muted-foreground">{event.count}</span>
            </li>)}</ul>
        </Tool>}

        {(done || failure) && <Tool icon={done ? <Sparkles className="size-3"/> : <AlertTriangle className="size-3"/>}
            title={done ? t("research.phaseSynthesize") : t("research.failed")}
            subtitle={done ? done.message : failure?.message}
            status={done ? "done" : "error"}/>}
    </>;
}
