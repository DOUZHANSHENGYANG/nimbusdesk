/**
 * 首页看板的数据整形：只做纯计算，图表的样式留在组件里。
 * 原则跟项目页的图一致——画的是真实数据，没有历史就画少一点，不补假点。
 */
import { addDays, type PlanTask } from "@/features/plans/types";

export interface DailyPoint {
  date: string;
  /** 轴上只显示 日/月 或 日 */
  label: string;
  done: number;
  total: number;
}

/** 近 n 天每天的计划完成数（活跃计划 + 已归档计划）。 */
export function dailyPlanSeries(
  days: Record<string, PlanTask[]>,
  archived: Record<string, { tasks: PlanTask[] }>,
  today: string,
  count = 7,
): DailyPoint[] {
  const points: DailyPoint[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = addDays(today, -offset);
    const tasks = days[date] ?? archived[date]?.tasks ?? [];
    points.push({
      date,
      label: date.slice(5),
      done: tasks.filter(task => task.done).length,
      total: tasks.length,
    });
  }
  return points;
}

export interface SlicePoint {
  key: string;
  value: number;
}

/** 工作项状态分布；顺序固定，图例不会因为计数变化而跳来跳去。 */
export function statusSlices(items: readonly { status: string }[]): SlicePoint[] {
  const order = ["doing", "todo", "done", "cancelled"] as const;
  return order.map(key => ({ key, value: items.filter(item => item.status === key).length }));
}

/** 环形图配色：直接取 token，深浅色主题自动跟着走。 */
export const SLICE_COLORS: Record<string, string> = {
  doing: "var(--chart-1)",
  todo: "var(--chart-3)",
  done: "var(--chart-2)",
  cancelled: "var(--chart-4)",
};
