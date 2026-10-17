import { useEffect, useMemo, useRef, useState } from "react";
import { ArchiveRestore, ChevronRight, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  childrenOf,
  dayProgress,
  inRange,
  parseDate,
  type DateRange,
} from "@/features/plans/types";
import { restoreDay, usePlansArchive } from "@/features/plans/store";
import { ReadOnlyTree } from "@/features/plans/views/shared";
import { DateRangePicker } from "@/features/plans/views/date-range";
import { useModal } from "@/components/shell/modal-host";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const EMPTY_RANGE: DateRange = { from: null, to: null };

/** 归档浏览视图：按日期倒序 + 时间区间/关键词筛选，展开只读树，可恢复 */
export function ArchiveView({ onRestore, searchDate, searchTaskId, searchToken }: { onRestore: (date: string) => void; searchDate?: string; searchTaskId?: string; searchToken?: string }) {
  const { t, i18n } = useTranslation();
  const archiveDays = usePlansArchive((s) => s.days);
  const { confirm } = useModal();
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [range, setRange] = useState<DateRange>(EMPTY_RANGE);
  const [keyword, setKeyword] = useState("");
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!searchDate || !archiveDays[searchDate]) return;
    setOpenDate(searchDate); setRange(EMPTY_RANGE); setKeyword("");
  }, [searchDate, searchToken, archiveDays]);
  useEffect(() => {
    if (!searchTaskId || openDate !== searchDate) return;
    const frame = requestAnimationFrame(() => Array.from(container.current?.querySelectorAll<HTMLElement>("[data-search-task-id]") ?? []).find(row => row.dataset.searchTaskId === searchTaskId)?.scrollIntoView({ block: "center", behavior: "instant" }));
    return () => cancelAnimationFrame(frame);
  }, [openDate, searchDate, searchTaskId, searchToken]);

  const dateFmt = new Intl.DateTimeFormat(i18n.language === "en" ? "en-US" : "zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    weekday: "short",
  });

  const allDates = useMemo(
    () => Object.keys(archiveDays).sort((a, b) => b.localeCompare(a)),
    [archiveDays],
  );

  /** 关键词匹配任务标题（含子任务） */
  const matchesKeyword = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return null;
    return (date: string) => {
      const tasks = archiveDays[date]?.tasks ?? [];
      return tasks.some((task) => task.title.toLowerCase().includes(kw));
    };
  }, [keyword, archiveDays]);

  /** 筛选后的日期列表（日期区间 + 关键词，两者都满足） */
  const entries = useMemo(
    () =>
      allDates.filter((date) => {
        if (!inRange(date, range)) return false;
        if (matchesKeyword && !matchesKeyword(date)) return false;
        return true;
      }),
    [allDates, range, matchesKeyword],
  );

  const filtered = range.from != null || range.to != null || keyword.trim() !== "";
  const totalDays = allDates.length;
  const totalTasks = useMemo(
    () => entries.reduce((n, d) => n + (archiveDays[d]?.tasks.length ?? 0), 0),
    [entries, archiveDays],
  );

  const onRestoreClick = async (date: string) => {
    const ok = await confirm({
      title: t("plans.restoreConfirm", { date }),
    });
    if (!ok) return;
    if (restoreDay(date)) {
      toast.success(t("plans.restored", { date }));
      onRestore(date);
    }
  };

  // 归档库整体为空 —— 这时不该显示筛选栏，避免「筛选无结果」与「本来就没有」混淆
  if (totalDays === 0) {
    return (
      <p className="py-10 text-center text-[13px] text-muted-foreground">
        {t("plans.archiveEmpty")}
      </p>
    );
  }

  return (
    <div ref={container} className="flex flex-col gap-3">
      {/* ── 筛选栏 ── */}
      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker value={range} onChange={setRange} />

        {/* 关键词：按任务名筛日期 */}
        <div className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-2.5 py-1.5 transition-colors focus-within:border-brand/50">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t("plans.archiveSearch")}
            className="w-40 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/60"
          />
          {keyword && (
            <button
              type="button"
              onClick={() => setKeyword("")}
              title={t("plans.clearRange")}
              className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>

        <div className="flex-1" />

        {/* 结果计数：筛选后明确告诉用户剩多少 */}
        <span className="text-[11px] text-muted-foreground">
          {filtered
            ? t("plans.archiveFiltered", { days: entries.length, tasks: totalTasks })
            : t("plans.archiveTotal", { days: totalDays })}
        </span>

        {filtered && (
          <button
            type="button"
            onClick={() => {
              setRange(EMPTY_RANGE);
              setKeyword("");
            }}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3" />
            {t("plans.clearFilter")}
          </button>
        )}
      </div>

      {/* ── 结果列表 ── */}
      {entries.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-muted-foreground">
          {t("plans.archiveNoMatch")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {entries.map((date) => {
            const entry = archiveDays[date];
            const { done, total } = dayProgress(entry.tasks);
            const open = openDate === date;
            const kw = keyword.trim().toLowerCase();
            return (
              <div key={date} className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="flex items-center gap-2 px-3.5 py-2.5">
                  <button
                    type="button"
                    onClick={() => setOpenDate(open ? null : date)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <ChevronRight
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                        open && "rotate-90",
                      )}
                    />
                    <span className="text-[13px] font-semibold">
                      {dateFmt.format(parseDate(date))}
                    </span>
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {done}/{total}
                    </span>
                    {/* 折叠时也能看到匹配到的任务名，不必逐个展开 */}
                    {!open && kw && (
                      <span className="min-w-0 truncate text-[11px] text-muted-foreground/70">
                        {entry.tasks
                          .filter((task) => task.title.toLowerCase().includes(kw))
                          .map((task) => task.title)
                          .join(" · ")}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => void onRestoreClick(date)}
                    className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-brand/10 hover:text-brand"
                  >
                    <ArchiveRestore className="size-3.5" />
                    {t("plans.restore")}
                  </button>
                </div>

                {open && (
                  <div className="border-t border-border/60 px-3 py-2">
                    {/* 关键词筛选时只显示匹配的根任务及其子树 */}
                    {kw ? (
                      <FilteredTree tasks={entry.tasks} date={date} keyword={kw} />
                    ) : (
                      <ReadOnlyTree tasks={entry.tasks} date={date} searchTaskId={date === searchDate ? searchTaskId : undefined} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 只渲染命中关键词的根任务子树。
 *
 * 单独实现而不是给 ReadOnlyTree 加 filter 参数：ReadOnlyTree 还被归档预览等
 * 复用，塞进筛选逻辑会让它的语义变模糊。这里复用 childrenOf 保持树形一致。
 */
function FilteredTree({
  tasks,
  date,
  keyword,
}: {
  tasks: import("@/features/plans/types").PlanTask[];
  date: string;
  keyword: string;
}) {
  const hit = (title: string) => title.toLowerCase().includes(keyword);
  /** 命中自身，或任一后代命中 */
  const keep = (id: string): boolean => {
    const kids = childrenOf(tasks, id);
    if (kids.some((k) => hit(k.title) || keep(k.id))) return true;
    return false;
  };

  const roots = childrenOf(tasks, null).filter((task) => hit(task.title) || keep(task.id));

  if (roots.length === 0) {
    return <p className="py-2 text-[12px] text-muted-foreground">—</p>;
  }
  return <ReadOnlyTree tasks={tasks} date={date} only={new Set(roots.map((r) => r.id))} />;
}
