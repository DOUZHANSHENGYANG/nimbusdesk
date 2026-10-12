import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  CalendarCheck2,
  CircleDot,
  Folder,
  Monitor,
  ArrowRight,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { childrenOf, dayProgress, todayStr, type PlanTask } from "@/features/plans/types";
import { useDayTasks, usePlans } from "@/features/plans/store";
import { StatusButton, doneTitleStyle } from "@/features/plans/views/shared";
import { useFiles, useFences } from "@/stores/files";
import { ItemIcon } from "@/features/files/icons";
import { openPath, openUrl } from "@/lib/tauri";
import { gsap, useGSAP } from "@/lib/gsap";
import { cn } from "@/lib/utils";

/** 主页仪表盘：问候 + 统计 + 今日计划速览 + 最新收藏 */
export function HomePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const today = todayStr();
  const tasks = useDayTasks(today);
  const toggleDone = usePlans((s) => s.toggleDone);
  const items = useFiles((s) => s.items);
  const fences = useFences((s) => s.fences);

  const progress = dayProgress(tasks);
  const doing = tasks.filter((x) => x.status === "doing").length;
  const roots = childrenOf(tasks, null);
  const itemsCount = items.length;
  const fencesOn = Object.values(fences).filter((f) => f.open).length;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? t("home.morning") : hour < 18 ? t("home.afternoon") : t("home.evening");
  const dateLabel = new Intl.DateTimeFormat(i18n.language === "en" ? "en-US" : "zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());

  const latest = [...items].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);

  const wrapRef = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      gsap.from("[data-dash-card]", {
        autoAlpha: 0,
        y: 16,
        duration: 0.4,
        stagger: 0.06,
        ease: "power2.out",
        clearProps: "all",
      });
    },
    { scope: wrapRef },
  );

  return (
    <div className="h-full overflow-y-auto" ref={wrapRef}>
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-6 pb-10">
        {/* ── 问候 ── */}
        <div>
          <h2 className="text-[20px] font-semibold tracking-tight">
            {greeting}，{t("app.name")}
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{dateLabel}</p>
        </div>

        {/* ── 统计卡片 ── */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            icon={<CalendarCheck2 className="size-4" />}
            label={t("home.todayPlans")}
            value={progress.total}
            sub={
              progress.total > 0
                ? `${progress.done}/${progress.total}`
                : undefined
            }
            accent="brand"
            onClick={() => navigate("/plans")}
          />
          <StatCard
            icon={<CircleDot className="size-4" />}
            label={t("home.doing")}
            value={doing}
            accent="info"
            onClick={() => navigate("/plans")}
          />
          <StatCard
            icon={<Folder className="size-4" />}
            label={t("home.collections")}
            value={itemsCount}
            accent="success"
            onClick={() => navigate("/files")}
          />
          <StatCard
            icon={<Monitor className="size-4" />}
            label={t("home.fencesOn")}
            value={fencesOn}
            accent="warning"
            onClick={() => navigate("/files")}
          />
        </div>

        {/* ── 今日计划速览 ── */}
        <section className="rounded-2xl border border-border bg-card p-4">
          <SectionHeader
            title={t("home.plansToday")}
            action={t("home.goToPlans")}
            onAction={() => navigate("/plans")}
          />
          {roots.length === 0 ? (
            <p className="py-5 text-center text-[13px] text-muted-foreground">
              {t("home.noPlansToday")}
            </p>
          ) : progress.done === progress.total && progress.total > 0 ? (
            <p className="py-5 text-center text-[13px] font-medium text-success">
              {t("home.allDoneToday")}
            </p>
          ) : (
            <div className="flex flex-col">
              {roots.slice(0, 6).map((task) => (
                <TodayTaskRow key={task.id} task={task} onToggle={() => toggleDone(today, task.id)} />
              ))}
            </div>
          )}
        </section>

        {/* ── 最新收藏 ── */}
        <section className="rounded-2xl border border-border bg-card p-4">
          <SectionHeader
            title={t("home.latestItems")}
            action={t("home.goFiles")}
            onAction={() => navigate("/files")}
          />
          {latest.length === 0 ? (
            <p className="py-5 text-center text-[13px] text-muted-foreground">
              {t("home.noItems")}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {latest.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    const p = item.type === "url" ? openUrl(item.path) : openPath(item.path);
                    void p.catch(() => undefined);
                  }}
                  className="flex min-w-0 items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-left transition-colors hover:border-brand/40 hover:bg-surface-hover"
                >
                  <ItemIcon
                    type={item.type}
                    path={item.path}
                    iconUrl={item.iconUrl}
                    className="size-4"
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px]">{item.title}</span>
                  <ArrowRight className="size-3 shrink-0 text-muted-foreground/50" />
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function TodayTaskRow({ task, onToggle }: { task: PlanTask; onToggle: () => void }) {
  return (
    <div className="flex min-h-9 items-center gap-2.5 rounded-lg px-1.5 py-1 transition-colors hover:bg-surface-hover">
      <StatusButton status={task.status} onToggle={onToggle} />
      <span
        className="min-w-0 flex-1 truncate text-[13px]"
        style={doneTitleStyle(task.status === "done")}
      >
        {task.title}
      </span>
      {task.time && (
        <span className="shrink-0 rounded-md bg-muted px-1.5 py-px font-mono text-[11px] text-muted-foreground">
          {task.time}
        </span>
      )}
    </div>
  );
}

function SectionHeader({
  title,
  action,
  onAction,
}: {
  title: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h3 className="text-[13px] font-semibold text-foreground/90">{title}</h3>
      <button
        type="button"
        onClick={onAction}
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-brand"
      >
        {action}
        <ArrowRight className="size-3" />
      </button>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  accent,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  sub?: string;
  accent: "brand" | "info" | "success" | "warning";
  onClick: () => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  // 数字滚动
  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      const proxy = { v: 0 };
      gsap.to(proxy, {
        v: value,
        duration: 0.7,
        ease: "power2.out",
        onUpdate: () => {
          el.textContent = String(Math.round(proxy.v));
        },
      });
    },
    { dependencies: [value] },
  );

  const accentClass = {
    brand: "bg-brand/10 text-brand",
    info: "bg-info/10 text-info",
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
  }[accent];

  return (
    <button
      type="button"
      data-dash-card
      onClick={onClick}
      className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4 text-left shadow-[var(--pr-shadow-1)] transition-all duration-150 hover:-translate-y-0.5 hover:shadow-[var(--pr-shadow-2)]"
    >
      <span className={cn("grid size-8 place-items-center rounded-lg", accentClass)}>{icon}</span>
      <div className="flex items-baseline gap-2">
        <span ref={ref} className="text-[26px] font-bold leading-none tracking-tight">
          0
        </span>
        {sub && <span className="text-[12px] text-muted-foreground">{sub}</span>}
      </div>
      <span className="text-[12px] text-muted-foreground">{label}</span>
    </button>
  );
}
