import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePlans } from "@/features/plans/store";
import { presetRange, rangeDuration, todayStr } from "@/features/plans/types";
import { dateSpan } from "../stats";

/**
 * 「今天还没做」浮层：点导航右上角那颗按钮才出来。
 *
 * 以前它常驻占走 300px —— 一列空白面板把日历挤窄，为了显示「今天已经全部完成」，
 * 代价是整张月历少看两列。现在按需弹出，日历铺满。
 *
 * 只放「能立刻动手」的东西，不放图表 —— 图表是 stats 那一页的事，
 * 这里放一份重复的小图只会让两个地方都不完整。
 * 行是可直接勾的：在日历里看周排布时顺手把今天剩的划掉，不用跳页。
 */
export function PlansRail({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const days = usePlans((state) => state.days);
  const toggleDone = usePlans((state) => state.toggleDone);
  const today = todayStr();
  const todayTasks = days[today] ?? [];
  const open = todayTasks.filter((task) => task.parentId === null && !task.done).slice(0, 6);
  const week = presetRange("week");
  let minutes = 0;
  let unscheduled = 0;
  if (week.from && week.to) {
    for (const date of dateSpan(week.from, week.to)) {
      for (const task of days[date] ?? []) {
        if (task.done) continue;
        const duration = rangeDuration(task);
        if (duration == null) unscheduled++;
        else minutes += duration;
      }
    }
  }

  return (
    <aside
      role="dialog"
      aria-label={t("plans.railTodo")}
      className="max-h-[70vh] w-72 overflow-auto rounded-[var(--pr-radius-xl)] border border-border bg-card p-4 shadow-[var(--pr-shadow-3)]"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-[15px] font-semibold tracking-tight">{t("plans.railTodo")}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("plans.railClose")}
          className="grid size-6 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {open.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted-foreground">{t("plans.railAllDone")}</p>
      ) : (
        <div className="mt-2 flex flex-col">
          {open.map((task) => (
            <div key={task.id} className="flex h-9 items-center gap-2.5">
              <button
                type="button"
                role="checkbox"
                aria-checked={false}
                aria-label={t("home.toggleDone")}
                onClick={() => toggleDone(today, task.id)}
                className="size-[17px] flex-none rounded-full border-[1.5px] border-[var(--pr-gray-300)] transition-colors hover:border-brand"
              />
              <span className="min-w-0 flex-1 truncate text-[13.5px]">{task.title}</span>
              {task.start && (
                <span className="flex-none text-[12px] tabular-nums text-muted-foreground">{task.start}</span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 border-t border-border pt-3 text-[12.5px] text-muted-foreground">
        {t("plans.railWeek", { hours: Math.round(minutes / 60), count: unscheduled })}
      </div>
    </aside>
  );
}
