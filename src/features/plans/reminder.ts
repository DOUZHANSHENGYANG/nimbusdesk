/**
 * 任务提醒调度。
 *
 * 设计取舍见 `stores/reminders.ts`：**应用运行时提醒**，不做 Rust 后台常驻。
 *
 * `dueReminders()` 是纯函数 —— 时间、任务、已通知集合全部由参数传入，
 * 因此边界（跨午夜、提前量、已完成、去重）都能脱离 DOM 直接断言。
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { minutesOf, type PlanTask } from "@/features/plans/types";
import { usePlans } from "@/features/plans/store";
import { useReminderSettings } from "@/stores/reminders";
import { sendNotification } from "@/lib/notify";

/** 一条待发出的提醒 */
export interface DueReminder {
  /** 去重键：日期 + 任务 id + 起点的组合，改时间会生成新键 */
  key: string;
  date: string;
  taskId: string;
  title: string;
  /** 该任务应在哪个时间点提醒（分钟，可跨到次日 → 用绝对分钟表示） */
  triggerAt: number;
}

/** 一天有多少分钟 */
const DAY = 24 * 60;

/**
 * 绝对分钟：把「日期 + HH:mm」折算成一个可直接比较、可跨日的数值。
 * 只有相对同一起点（`base` 当天 0 点）才有意义，但足以处理跨午夜。
 */
function absoluteMinute(date: string, hhmm: string | undefined, base: string): number | null {
  const m = minutesOf(hhmm);
  if (m == null) return null;
  const [y1, mo1, d1] = date.split("-").map(Number);
  const [y2, mo2, d2] = base.split("-").map(Number);
  const days = Math.round(
    (Date.UTC(y1, mo1 - 1, d1) - Date.UTC(y2, mo2 - 1, d2)) / 86_400_000,
  );
  return days * DAY + m;
}

/**
 * 算出「此刻应该提醒」的条目。
 *
 * 触发条件（全部满足）：
 * 1. 任务有 `start`（没设时间就不可能到点）
 * 2. 未完成
 * 3. `now` 已经到达 `start - advance`
 * 4. 尚未通知过（`notified` 里去重）
 *
 * 刻意**不设「过期太久就不补发」的窗口**：应用可能被托盘最小化很久，
 * 回来时把错过的提醒一次性补上，比静默丢掉更符合「提醒」的语义。
 *
 * @param days    日期 → 任务数组（通常今天与明天两天）
 * @param base    计算相对分钟所用的基准日（通常是今天）
 * @param nowMin  「现在」相对 base 的分钟数（可 > 1440，表示已过午夜）
 */
export function dueReminders(
  days: Record<string, PlanTask[] | undefined>,
  base: string,
  nowMin: number,
  advance: number,
  notified: readonly string[],
): DueReminder[] {
  const seen = new Set(notified);
  const out: DueReminder[] = [];

  for (const [date, tasks] of Object.entries(days)) {
    for (const task of tasks ?? []) {
      if (task.done || !task.start) continue;
      const startAt = absoluteMinute(date, task.start, base);
      if (startAt == null) continue;
      if (nowMin < startAt - advance) continue;
      const key = `${date}:${task.id}:${task.start}`;
      if (seen.has(key)) continue;
      seen.add(key); // 同一次计算里同键只出一次（防御性：tasks 不应有重复 id）
      out.push({ key, date, taskId: task.id, title: task.title, triggerAt: startAt - advance });
    }
  }
  // 先到先提醒
  return out.sort((a, b) => a.triggerAt - b.triggerAt);
}

/** 提前量文案：0 显示「开始时提醒」，否则「N 分钟前提醒」 */
export function advanceLabel(
  advance: number,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  return advance <= 0
    ? t("settings.reminderAtStart")
    : t("settings.reminderMinutes", { count: advance });
}

/** 每轮重读设置，所以用 setTimeout 自调度而不是 setInterval */
const CHECK_INTERVAL_MS = 30_000;

/**
 * 挂到根布局（`Providers`）—— 只在主窗口生效。
 *
 * `Providers` 仅被 `App` 使用，而栅栏走 `FenceWindow`、菜单浮窗走
 * `MenuPopupWindow`（见 `main.tsx` 的按 label 分流），所以这里不必再判断
 * 窗口 label：那需要读 Tauri 内部结构，脆弱且会随版本变化。
 */
export function useReminderLoop() {
  const { t } = useTranslation();

  useEffect(() => {
    let timer: number | undefined;

    const run = () => {
      const { enabled, advance, notified, markNotified } = useReminderSettings.getState();
      if (enabled) {
        const days = usePlans.getState().days;
        const now = new Date();
        const base = toDateStr(now);
        const tomorrow = toDateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
        const nowMin = now.getHours() * 60 + now.getMinutes();

        // 只看今天与明天：更早的已归档，更晚的不需要提醒
        const scope = { [base]: days[base], [tomorrow]: days[tomorrow] };
        for (const d of dueReminders(scope, base, nowMin, advance, notified)) {
          markNotified(d.key);
          void sendNotification(t("settings.reminder"), d.title);
        }
      }
      timer = window.setTimeout(run, CHECK_INTERVAL_MS);
    };

    run();
    return () => window.clearTimeout(timer);
  }, [t]);
}

/** 本地日期 YYYY-MM-DD（与 plans 的 fmtDate 同语义，此处不引它以免循环依赖） */
function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
