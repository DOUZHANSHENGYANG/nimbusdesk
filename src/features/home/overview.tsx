import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { CalendarCheck, ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DashboardCard, SegmentBar, StatTile } from "@/components/ui/dashboard";
import { cn } from "@/lib/utils";
import { childrenOf, rangeLabel, type PlanTask } from "@/features/plans/types";
import { itemDeadline } from "@/features/projects/core";
import { useProjects } from "@/features/projects/store";
import { useFeeds } from "@/stores/feeds";
import { useSettings } from "@/stores/settings";
import { mergedSources } from "@/sources/custom";
import type { InboxSummary } from "./inspector";
import { latestEntries, pickHomeFeed, prioritizeWorkItems, timeAgo } from "./overview-core";

/**
 * 首页概览：一屏摊开今天要动的四件事——今日计划、待办工作项、笔记、资讯。
 *
 * 版式与项目页总览共用 `components/ui/dashboard` 里的数字格与卡片，所以两页的比例、字号、
 * 间距是同一套。每张卡只回答一个问题，卡片内部只放“能直接动手”的东西：
 * 计划勾得掉、工作项点得开、笔记进收件箱、资讯进渠道；不在这里做管理动作。
 */
export function HomeOverview(props: {
  tasks: PlanTask[];
  progress: { done: number; total: number };
  inbox: InboxSummary;
  root: string | null;
  today: string;
  now: number;
  onToggle: (id: string) => void;
  onCapture: () => void;
  captureBusy: boolean;
  onRetryInbox: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const workItems = useProjects(state => state.items);
  const iterations = useProjects(state => state.iterations);
  const projects = useProjects(state => state.projects);
  const entriesBySource = useFeeds(state => state.entriesBySource);
  const lastFetchedAt = useFeeds(state => state.lastFetchedAt);
  const homeFeedSource = useSettings(state => state.homeFeedSource);
  const sources = useMemo(() => mergedSources(), []);
  const sourceName = (id: string) => sources.find(source => source.id === id)?.name ?? id;

  const roots = childrenOf(props.tasks, null);
  const planProgress = props.progress;
  const planRate = planProgress.total ? Math.round((planProgress.done / planProgress.total) * 100) : 0;
  const open = useMemo(() => workItems.map(item => ({ ...item, deadline: itemDeadline(item, iterations) })).filter(item => item.status === "todo" || item.status === "doing"), [workItems, iterations]);
  const overdue = open.filter(item => item.deadline && item.deadline < props.today).length;
  const todo = useMemo(() => prioritizeWorkItems(open, 5), [open]);
  /** 资讯卡片只显示一个渠道：默认是我订阅顺序里的第一个源，可在设置里改。 */
  const homeFeed = pickHomeFeed(sources, homeFeedSource);
  const feedEntries = homeFeed ? entriesBySource[homeFeed.id] ?? [] : [];
  const feeds = useMemo(() => homeFeed ? latestEntries({ [homeFeed.id]: entriesBySource[homeFeed.id] ?? [] }, 4) : [], [homeFeed, entriesBySource]);
  const fetched = homeFeed ? lastFetchedAt[homeFeed.id] ?? 0 : 0;
  const ago = (value: number | undefined) => {
    if (!value) return "";
    const { amount, unit } = timeAgo(value, props.now);
    return t(`home.${unit}sAgo`, { count: amount });
  };
  const projectName = (id: string | null) => (id ? projects.find(project => project.id === id)?.name ?? "" : "");

  return <div className="flex min-h-0 w-full flex-1 flex-col gap-2">
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile id="plans" label={t("home.todayPlans")} value={`${planProgress.done}/${planProgress.total}`} hint={`${planRate}%`} />
      <StatTile id="work" label={t("home.workItems")} value={open.length} hint={t("home.overviewOverdue", { count: overdue })} tone={overdue ? "text-amber-700 dark:text-amber-400" : undefined} />
      <StatTile id="notes" label={t("home.notes")} value={props.inbox.status === "ready" ? props.inbox.records.length : "—"} hint={t("home.inboxPending")} />
      <StatTile id="feeds" label={t("home.feeds")} value={feedEntries.length} hint={fetched ? ago(fetched) : t("home.feedsEmptyShort")} />
    </div>

    <div className="grid gap-2 lg:grid-cols-2">
      <DashboardCard title={t("home.todayPlans")} action={<span className="pr-0.5 text-[11px] tabular-nums text-muted-foreground">{t("home.progressLabel", { done: planProgress.done, total: planProgress.total })}</span>}>
        <SegmentBar total={planProgress.total} segments={[
          { key: "done", count: planProgress.done, className: "bg-emerald-500" },
          { key: "open", count: Math.max(0, planProgress.total - planProgress.done), className: "bg-muted-foreground/30" },
        ]} />
        <div className="mt-1.5 min-h-0 flex-1 space-y-0.5">
          {roots.slice(0, 6).map(task => <div key={task.id} className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-muted">
            <button type="button" role="checkbox" aria-checked={task.done} aria-label={t("home.toggleDone")} onClick={() => props.onToggle(task.id)}
              className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border border-muted-foreground/50 outline-none focus-visible:ring-2 focus-visible:ring-ring", task.done && "border-emerald-500 bg-emerald-500 text-white")}>
              {task.done && <CalendarCheck className="size-3" />}
            </button>
            <button type="button" onClick={() => navigate(`/plans?date=${props.today}&task=${encodeURIComponent(task.id)}`)}
              className={cn("min-w-0 flex-1 truncate text-left text-[12.5px] outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring", task.done && "text-muted-foreground line-through decoration-muted-foreground/40")}>{task.title}</button>
            {rangeLabel(task) && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{rangeLabel(task)}</span>}
          </div>)}
          {!roots.length && <p className="px-1.5 py-1 text-[11.5px] text-muted-foreground">{t("home.noPlansToday")}</p>}
        </div>
        <CardLink label={t("home.goToPlans")} onClick={() => navigate("/plans")} />
      </DashboardCard>

      <DashboardCard title={t("home.workItems")} action={<span className="pr-0.5 text-[11px] tabular-nums text-muted-foreground">{open.length}</span>}>
        <div className="min-h-0 flex-1 space-y-0.5">
          {todo.map(item => <button key={item.id} type="button" onClick={() => navigate(`/projects?item=${encodeURIComponent(item.id)}`)}
            className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
            <span className={cn("size-2 shrink-0 rounded-full", item.status === "doing" ? "bg-primary" : "bg-muted-foreground/40")} />
            <span className="min-w-0 flex-1 truncate text-[12.5px]">{item.title}</span>
            {projectName(item.projectId) && <span className="max-w-[96px] shrink-0 truncate text-[11px] text-muted-foreground">{projectName(item.projectId)}</span>}
            {item.deadline && <span className={cn("shrink-0 text-[11px] tabular-nums", item.deadline < props.today ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>{item.deadline.slice(5).replace("-", "/")}</span>}
          </button>)}
          {!todo.length && <p className="px-1.5 py-1 text-[11.5px] text-muted-foreground">{t("home.workItemsEmpty")}</p>}
        </div>
        <CardLink label={t("home.goProjects")} onClick={() => navigate("/projects")} />
      </DashboardCard>

      <DashboardCard title={t("home.notes")} action={<div className="flex items-center gap-1">
        {props.root && <Button variant="ghost" size="icon-xs" aria-label={t("home.quickCapture")} title={t("home.quickCapture")} disabled={props.captureBusy} onClick={props.onCapture}><Plus /></Button>}
        <span className="pr-0.5 text-[11px] tabular-nums text-muted-foreground">{props.inbox.status === "ready" ? props.inbox.records.length : "—"}</span>
      </div>}>
        <div className="min-h-0 flex-1 space-y-0.5">
          {!props.root && <div className="space-y-1 px-1.5 py-1">
            <p className="text-[11.5px] text-muted-foreground">{t("home.vaultUnbound")}</p>
            <Button size="sm" variant="outline" onClick={() => navigate("/knowledge")}>{t("home.connectVault")}</Button>
          </div>}
          {props.root && props.inbox.status === "loading" && <p className="px-1.5 py-1 text-[11.5px] text-muted-foreground">{t("home.loadingInbox")}</p>}
          {props.root && props.inbox.status === "error" && <div className="flex items-center gap-2 px-1.5 py-1"><p className="text-[11.5px] text-destructive">{t("home.inboxUnavailable")}</p><Button size="sm" variant="link" className="h-auto p-0" onClick={props.onRetryInbox}>{t("home.retry")}</Button></div>}
          {props.root && props.inbox.status === "ready" && <>
            {props.inbox.records.slice(0, 4).map(record => <button key={record.id} type="button" onClick={() => navigate("/knowledge")}
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
              <span className="min-w-0 flex-1 truncate text-[12.5px]">{record.title}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{ago(record.createdAt)}</span>
            </button>)}
            {!props.inbox.records.length && <p className="px-1.5 py-1 text-[11.5px] text-muted-foreground">{t("home.emptyInbox")}</p>}
          </>}
        </div>
        <CardLink label={t("home.goKnowledge")} onClick={() => navigate("/knowledge")} />
      </DashboardCard>

      <DashboardCard title={t("home.feeds")} action={<span className="max-w-[120px] truncate pr-0.5 text-[11px] text-muted-foreground">{homeFeed ? homeFeed.name : t("home.feedSources", { count: sources.length })}</span>}>
        <div className="min-h-0 flex-1 space-y-0.5">
          {feeds.map(({ sourceId, entry }) => <button key={entry.id} type="button" onClick={() => navigate("/feeds")}
            className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
            <span className="min-w-0 flex-1 truncate text-[12.5px]">{entry.title}</span>
            <span className="max-w-[96px] shrink-0 truncate text-[11px] text-muted-foreground">{sourceName(sourceId)}</span>
            {entry.pubDate && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{ago(entry.pubDate)}</span>}
          </button>)}
          {!feeds.length && <p className="px-1.5 py-1 text-[11.5px] text-muted-foreground">{t("home.feedsEmpty")}</p>}
        </div>
        <CardLink label={t("home.goFeeds")} onClick={() => navigate("/feeds")} />
      </DashboardCard>
    </div>
  </div>;
}

/** 卡片底部那一条“去哪儿”：四张卡都有，所以做成一个小组件保证外观一致。 */
function CardLink({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick}
    className="mt-1 flex w-full items-center justify-between rounded-md px-1.5 py-1 text-[11px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
    {label}<ChevronRight className="size-3" />
  </button>;
}
