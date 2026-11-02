import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Bot, BookOpen, CalendarCheck, ChevronLeft, ChevronRight, Folder, FolderKanban, Newspaper, NotebookPen, Sparkles, Terminal } from "lucide-react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { ScrambleNumber } from "@/components/ui/scramble-number";
import { cn } from "@/lib/utils";
import type { PlanTask } from "@/features/plans/types";
import { usePlans, usePlansArchive } from "@/features/plans/store";
import { itemDeadline, projectProgress } from "@/features/projects/core";
import { useProjects } from "@/features/projects/store";
import { useFeeds } from "@/stores/feeds";
import { useFiles } from "@/stores/files";
import { mergedSources } from "@/sources/custom";
import { useData } from "@/ahub/stores/data";
import { loadHarnessReports } from "@/ahub/lib/harnessScan";
import type { InboxSummary } from "./inspector";
import { latestEntries, timeAgo } from "./overview-core";
import { dailyPlanSeries } from "./charts";

/**
 * 首页看板：读数 → 计划与项目 / 今日资讯 → 收纳盒 → AI 资源。
 *
 * 图上只画本机真实数据：近七天画的是"每天排了几条计划"，没有历史就不补点。
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
  const days = usePlans(state => state.days);
  const archived = usePlansArchive(state => state.days);
  const categories = useFiles(state => state.categories);
  const files = useFiles(state => state.items);
  const prompts = useData(state => state.prompts.length);
  const mcp = useData(state => state.mcp.length);
  const skills = useData(state => state.skills.length);
  const [harnessCount, setHarnessCount] = useState<number | null>(null);
  const sources = useMemo(() => mergedSources(), []);

  // AI 资源数量：只读本地清单，失败就显示占位，不在首页做重活
  useEffect(() => {
    const state = useData.getState();
    void state.loadPrompts().catch(() => undefined);
    void state.loadMcp().catch(() => undefined);
    void state.loadSkills().catch(() => undefined);
    void loadHarnessReports().then(reports => setHarnessCount(reports.length)).catch(() => setHarnessCount(null));
  }, []);

  const planProgress = props.progress;
  const planRate = planProgress.total ? Math.round((planProgress.done / planProgress.total) * 100) : 0;
  const open = useMemo(() => workItems.map(item => ({ ...item, deadline: itemDeadline(item, iterations) })).filter(item => item.status === "todo" || item.status === "doing"), [workItems, iterations]);
  const overdue = open.filter(item => item.deadline && item.deadline < props.today).length;
  const notes = props.inbox.status === "ready" ? props.inbox.records.length : null;
  const series = useMemo(() => dailyPlanSeries(days, archived, props.today, 7), [days, archived, props.today]);
  const progress = useMemo(() => projects
    .filter(project => project.status !== "archived")
    .map(project => ({ project, value: projectProgress(project, workItems, props.today).value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6), [projects, workItems, props.today]);

  /** 今日资讯：有内容的源按最新一条排序，前端只做一页一源的"幻灯片" */
  const feedSlides = useMemo(() => sources
    .map(source => ({ source, entries: latestEntries({ [source.id]: entriesBySource[source.id] ?? [] }, 3) }))
    .filter(slide => slide.entries.length)
    .slice(0, 6), [sources, entriesBySource]);
  const [slide, setSlide] = useState(0);
  const currentSlide = feedSlides[Math.min(slide, Math.max(0, feedSlides.length - 1))];

  const boxes = useMemo(() => categories.filter(category => !category.parentId).slice(0, 8)
    .map(category => ({ category, count: files.filter(item => item.categoryId === category.id).length })), [categories, files]);

  const ago = (value: number | undefined) => {
    if (!value) return "";
    const { amount, unit } = timeAgo(value, props.now);
    return t(`home.${unit}sAgo`, { count: amount });
  };

  return <div className="flex min-h-0 w-full flex-1 flex-col gap-2.5">
    {/* 左列：柱状图 → 四个卡片 → 四个 AI 功能 → 收纳盒；右列：项目前 3 条 → 今日资讯（10 条高）
        两列都吃掉剩余高度：柱状图与资讯卡 flex-1（资讯至少 10 条高），窗口变高就跟着长 */}
    <div className="grid min-h-0 flex-1 gap-2.5 lg:grid-cols-3">
      <div className="flex min-h-0 flex-col gap-2.5 lg:col-span-2">
        <Panel className="flex-1" title={t("home.planCount7d")} hint={t("home.planCount7dHint", { count: series.reduce((sum, point) => sum + point.total, 0) })}>
          <div className="h-full min-h-[150px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} barCategoryGap="28%">
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
                <YAxis hide domain={[0, "dataMax + 1"]} allowDecimals={false} />
                <Tooltip cursor={{ fill: "var(--muted)" }} contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--popover-foreground)" }} />
                <Bar name={t("home.planCount")} dataKey="total" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={38} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        {/* 四个读数 */}
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi stat="plans" icon={<CalendarCheck className="size-4" />} label={t("home.todayPlans")} value={`${planProgress.done}/${planProgress.total}`} sub={`${planRate}%`} onClick={() => navigate("/plans")} />
          <Kpi stat="work" icon={<FolderKanban className="size-4" />} label={t("home.workItems")} value={open.length} sub={overdue ? t("home.overviewOverdue", { count: overdue }) : t("home.noOverdue")} tone={overdue ? "text-warning" : undefined} onClick={() => navigate("/projects")} />
          <Kpi stat="notes" icon={<NotebookPen className="size-4" />} label={t("home.notes")} value={notes ?? "—"} sub={t("home.inboxPending")} onClick={() => navigate("/ai/knowledge")} />
          <Kpi stat="feeds" icon={<Newspaper className="size-4" />} label={t("home.feeds")} value={feedSlides.reduce((sum, item) => sum + item.entries.length, 0)} sub={t("home.todayFeeds")} onClick={() => navigate("/tools/feeds")} />
        </div>

        {/* 四个 AI 功能：直接进对应页；原来那排「资源计数」已并进这里，同一批目标不出现两次 */}
        <Panel title={t("home.aiFeatures")}>
          <div className="grid gap-2 sm:grid-cols-2">
            <AiTile icon={<Bot className="size-4" />} label={t("nav.agent")} onClick={() => navigate("/ai/agent")} />
            <AiTile icon={<BookOpen className="size-4" />} label={t("nav.knowledge")} value={notes ?? "—"} onClick={() => navigate("/ai/knowledge")} />
            <AiTile icon={<Sparkles className="size-4" />} label={t("nav.plugins")} value={prompts + skills + mcp} onClick={() => navigate("/toolbox/prompts")} />
            <AiTile icon={<Terminal className="size-4" />} label={t("nav.runtime")} value={harnessCount ?? "—"} onClick={() => navigate("/toolbox/harness")} />
          </div>
        </Panel>

        {/* 文件收纳盒：只做快速访问，不接拖拽 */}
        <Panel title={t("home.boxes")} hint={String(categories.filter(category => !category.parentId).length)} action={<CardLink label={t("home.goFiles")} onClick={() => navigate("/tools/files")} />}>
          <div className="flex flex-wrap gap-2">
            {boxes.map(({ category, count }) => <button key={category.id} type="button" onClick={() => navigate("/tools/files")}
              className="flex min-w-[112px] flex-1 items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2 text-left outline-none hover:border-brand/40 focus-visible:ring-2 focus-visible:ring-ring">
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[12.5px]">{category.name}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{count}</span>
            </button>)}
            {!boxes.length && <p className="px-1 py-2 text-[11.5px] text-muted-foreground">{t("home.noBoxes")}</p>}
          </div>
        </Panel>
      </div>

      <div className="flex min-h-0 flex-col gap-2.5">
        {/* 项目：只列前 3 条，其余去项目管理看 */}
        <Panel title={t("home.currentProjects")} hint={String(progress.length)} action={<CardLink label={t("home.goProjects")} onClick={() => navigate("/projects")} />}>
          {progress.length ? <div className="space-y-1">
            {progress.slice(0, 3).map(({ project, value }) => <button key={project.id} type="button" onClick={() => navigate(`/projects?project=${encodeURIComponent(project.id)}`)}
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
              <span className="min-w-0 flex-1 truncate text-[12.5px]" title={project.name}>{project.name}</span>
              <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-foreground/10">
                <span className="block h-full rounded-full transition-[width] duration-300" style={{ width: `${value}%`, background: "var(--chart-1)" }} />
              </span>
              <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{value}%</span>
            </button>)}
          </div> : <p className="px-1 py-2 text-[11.5px] text-muted-foreground">{t("home.noProjects")}</p>}
        </Panel>

        {/* 今日资讯：至少「十条」高，窗口更高就跟着长；再多在里面滚 */}
        <Panel className="min-h-0 flex-1" title={t("home.todayFeeds")} hint={currentSlide ? currentSlide.source.name : t("home.feedsEmptyShort")}
          action={feedSlides.length > 1 ? <span className="flex items-center gap-0.5">
            <Button variant="ghost" size="icon-xs" aria-label={t("home.prevSlide")} onClick={() => setSlide(value => (value - 1 + feedSlides.length) % feedSlides.length)}><ChevronLeft /></Button>
            <Button variant="ghost" size="icon-xs" aria-label={t("home.nextSlide")} onClick={() => setSlide(value => (value + 1) % feedSlides.length)}><ChevronRight /></Button>
          </span> : undefined}>
          {currentSlide ? <div data-feed-slide className="flex min-h-[360px] flex-1 flex-col gap-1.5 overflow-y-auto">
            {currentSlide.entries.map(({ entry }) => <button key={entry.id} type="button" onClick={() => navigate("/tools/feeds")}
              className="flex min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
              <span className="line-clamp-2 text-[12.5px] leading-5">{entry.title}</span>
              {entry.pubDate && <span className="text-[11px] tabular-nums text-muted-foreground">{ago(entry.pubDate)}</span>}
            </button>)}
          </div> : <p className="px-1 py-6 text-center text-[11.5px] text-muted-foreground">{t("home.feedsEmpty")}</p>}
          <div className="flex items-center justify-between gap-2 pt-1">
            {feedSlides.length > 1 ? <span className="flex items-center gap-1">
              {feedSlides.map((item, index) => <span key={item.source.id} aria-hidden className={cn("h-1 rounded-full transition-all", index === slide ? "w-4 bg-brand" : "w-1.5 bg-foreground/20")} />)}
            </span> : <span />}
            <CardLink label={t("home.goFeeds")} onClick={() => navigate("/tools/feeds")} />
          </div>
        </Panel>
      </div>
    </div>
  </div>;
}

function AiTile({ icon, label, value, onClick }: { icon: React.ReactNode; label: string; value?: number | string; onClick: () => void }) {
  return <button type="button" onClick={onClick}
    className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2 text-left outline-none hover:border-brand/40 focus-visible:ring-2 focus-visible:ring-ring">
    <span className="shrink-0 text-muted-foreground">{icon}</span>
    <span className="min-w-0 flex-1 truncate text-[12.5px]">{label}</span>
    {value !== undefined && <span className="shrink-0 text-[15px] font-semibold tabular-nums">{value}</span>}
    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
  </button>;
}

function Kpi({ stat, icon, label, value, sub, tone, onClick, action }: {
  stat: string;
  icon: React.ReactNode;
  label: string;
  value: number | string;
  sub: string;
  tone?: string;
  onClick: () => void;
  action?: React.ReactNode;
}) {
  return <div data-stat={stat} className="group relative rounded-xl border border-border bg-muted/10 p-3">
    <button type="button" onClick={onClick} className="flex w-full min-w-0 flex-col items-start gap-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="flex w-full items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-foreground/5 text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{label}</span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
      </span>
      <span data-stat-value className="text-[24px] leading-tight font-semibold tabular-nums">
        <ScrambleNumber value={value} />
      </span>
      <span className={cn("truncate text-[11px]", tone ?? "text-muted-foreground")}>{sub}</span>
    </button>
    {action && <span className="absolute top-2 right-8">{action}</span>}
  </div>;
}

function Panel({ title, hint, action, className, children }: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return <section className={cn("flex min-w-0 flex-col rounded-xl border border-border bg-muted/10 p-2.5", className)}>
    <header className="mb-2 flex min-h-6 items-center justify-between gap-2">
      <h3 className="truncate text-[12.5px] font-medium text-foreground">{title}</h3>
      {action ?? (hint ? <span className="shrink-0 truncate text-[11px] text-muted-foreground">{hint}</span> : null)}
    </header>
    {children}
  </section>;
}

function CardLink({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick}
    className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
    {label}<ChevronRight className="size-3" />
  </button>;
}
