/**
 * 定时任务的纯逻辑：类型、频率人话文案、参数校验。
 *
 * 这里**不算下次运行时刻** —— 那是 Rust 的事（`schedule_preview` 命令）。
 * 两处各算一套必然漂移：日历边界（31 号在 2 月、闰年、跨年）只该有一个答案。
 * 前端只负责两件它天生擅长的事：把频率说成人话、把非法输入挡在提交之前。
 */

export type Frequency =
    | { kind: "once"; at: string }
    | { kind: "daily"; time: string }
    | { kind: "weekly"; weekdays: number[]; time: string }
    | { kind: "monthly"; day: number; time: string }
    | { kind: "yearly"; month: number; day: number; time: string }
    | { kind: "interval"; minutes: number };

export type FrequencyKind = Frequency["kind"];

export interface ActionSpec { id: string; params: Record<string, unknown> }

export interface TaskInput {
    name: string;
    frequency: Frequency;
    action: ActionSpec;
    enabled: boolean;
    runIfMissed: boolean;
}

export interface Task extends TaskInput {
    id: string;
    nextRun: string | null;
    lastRun: string | null;
    lastStatus: string | null;
}

export interface HistoryEntry {
    id: string;
    taskId: string;
    taskName: string;
    at: string;
    status: "success" | "failed" | "skipped";
    ms: number;
    error?: string;
    note?: string;
    reason?: string;
}

export interface ActionField {
    name: string;
    type: "text" | "textarea" | "prompt" | "source" | "checkbox";
    label: string;
    hint?: string;
}

export interface ActionInfo {
    id: string;
    label: string;
    timeoutMs: number;
    delegated: boolean;
    fields: ActionField[];
}

export interface Snapshot {
    tasks: Task[];
    history: HistoryEntry[];
    actions: ActionInfo[];
}

/** i18next 的 `t` 的窄接口 —— 让这里可以脱离 React 单测。 */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

export const FREQUENCY_KINDS: FrequencyKind[] = ["once", "daily", "weekly", "monthly", "yearly", "interval"];

/** 频率选择器里的默认值（新建任务、切换频率都走这里）。 */
export function defaultFrequency(kind: FrequencyKind, now = new Date()): Frequency {
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    switch (kind) {
        case "once":
            // 默认一小时后：一次性任务最常被用来试跑，别默认到过去
            return { kind, at: localDateTime(new Date(now.getTime() + 60 * 60 * 1000)) };
        case "daily":
            return { kind, time };
        case "weekly":
            return { kind, weekdays: [1], time };
        case "monthly":
            return { kind, day: 1, time };
        case "yearly":
            return { kind, month: 1, day: 1, time };
        case "interval":
            return { kind, minutes: 30 };
    }
}

/** `Date` → `<input type="datetime-local">` 需要的 "YYYY-MM-DDTHH:MM"。 */
export function localDateTime(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 频率 → 人话。zh/en 的差异全在 i18n 表里，这里只拼参数。 */
export function describeFrequency(frequency: Frequency, t: Translate): string {
    switch (frequency.kind) {
        case "once":
            return t("schedule.freq.once", { at: formatStamp(frequency.at) });
        case "daily":
            return t("schedule.freq.daily", { time: frequency.time });
        case "weekly":
            return t("schedule.freq.weekly", {
                days: weekdayNames(frequency.weekdays, t),
                time: frequency.time,
            });
        case "monthly":
            return t("schedule.freq.monthly", { day: frequency.day, time: frequency.time });
        case "yearly":
            return t("schedule.freq.yearly", { month: frequency.month, day: frequency.day, time: frequency.time });
        case "interval":
            return t("schedule.freq.interval", { minutes: frequency.minutes });
    }
}

/** 星期名列表：去重、按周一到周日排序，用当前语言的顿号连接。 */
export function weekdayNames(weekdays: number[], t: Translate): string {
    const unique = [...new Set(weekdays)].sort((a, b) => a - b);
    return unique.map((day) => t(`schedule.weekday.${day}`)).join(t("schedule.weekdaySep"));
}

/** "2026-10-22T09:30:00" / "2026-10-22T09:30" → "2026-10-22 09:30"；空值给空串 */
export function formatStamp(value: string | null | undefined): string {
    if (!value) return "";
    // 只剥秒（存在才剥）：分钟级 "09:30" 不能被当成 "09:30:00" 把分钟也削掉
    return value.replace("T", " ").replace(/(\d{2}:\d{2}):\d{2}$/, "$1");
}

/** 历史三态的 i18n key */
export function statusLabel(status: string): string {
    if (status === "success" || status === "failed" || status === "skipped") {
        return `schedule.history.status.${status}`;
    }
    return "schedule.history.status.unknown";
}

const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function parseTime(value: string): { hour: number; minute: number } | null {
    const match = TIME_RE.exec((value ?? "").trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

function realDate(year: number, month: number, day: number): boolean {
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const probe = new Date(Date.UTC(year, month - 1, day));
    return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function integer(value: unknown): boolean {
    return typeof value === "number" && Number.isInteger(value);
}

/**
 * 频率校验。返回 i18n key，合法则返回 null。
 *
 * `once` 额外要求晚于 `now`：已经过去的一次性任务排了也不会跑，
 * 与其让它静静躺着，不如在保存时就说清楚。
 */
export function validateFrequency(frequency: Frequency, now = new Date()): string | null {
    switch (frequency.kind) {
        case "once": {
            const match = DATE_TIME_RE.exec((frequency.at ?? "").trim());
            if (!match) return "schedule.err.dateInvalid";
            const [, year, month, day, hour, minute] = match;
            if (!realDate(Number(year), Number(month), Number(day))) return "schedule.err.dateInvalid";
            if (Number(hour) > 23 || Number(minute) > 59) return "schedule.err.dateInvalid";
            const when = new Date(frequency.at.trim());
            if (Number.isNaN(when.getTime())) return "schedule.err.dateInvalid";
            return when.getTime() > now.getTime() ? null : "schedule.err.oncePast";
        }
        case "daily":
            return parseTime(frequency.time) ? null : "schedule.err.timeInvalid";
        case "weekly": {
            const days = frequency.weekdays ?? [];
            if (!days.length) return "schedule.err.weekdaysEmpty";
            if (!days.every((day) => integer(day) && day >= 1 && day <= 7)) return "schedule.err.weekdaysEmpty";
            return parseTime(frequency.time) ? null : "schedule.err.timeInvalid";
        }
        case "monthly":
            if (!integer(frequency.day) || frequency.day < 1 || frequency.day > 31) return "schedule.err.dayRange";
            return parseTime(frequency.time) ? null : "schedule.err.timeInvalid";
        case "yearly":
            if (!integer(frequency.month) || frequency.month < 1 || frequency.month > 12) return "schedule.err.monthRange";
            if (!integer(frequency.day) || frequency.day < 1 || frequency.day > 31) return "schedule.err.dayRange";
            // 2 月 30 日这种「哪一年都不存在」的组合直接挡掉；2 月 29 日留给闰年
            if (!realDate(2028, frequency.month, frequency.day)) return "schedule.err.dayRange";
            return parseTime(frequency.time) ? null : "schedule.err.timeInvalid";
        case "interval":
            if (!integer(frequency.minutes) || frequency.minutes < 1 || frequency.minutes > 1440) return "schedule.err.minutesRange";
            return null;
    }
}

/** 任务整体校验（名称 + 频率 + 动作参数）。返回第一个出错的 i18n key。 */
export function validateTask(task: TaskInput, now = new Date()): string | null {
    const name = (task.name ?? "").trim();
    if (!name) return "schedule.err.nameRequired";
    if (name.length > 100) return "schedule.err.nameTooLong";
    const frequency = validateFrequency(task.frequency, now);
    if (frequency) return frequency;
    if (!task.action?.id) return "schedule.err.actionRequired";
    if (task.action.id === "ai_prompt") {
        const params = task.action.params ?? {};
        const prompt = String(params.promptId ?? "").trim();
        const instruction = String(params.instruction ?? "").trim();
        if (!prompt && !instruction) return "schedule.err.aiPromptRequired";
    }
    return null;
}

/** 错误码 → i18n key；未知错误码原样展示（后端错误码本身是可读的）。 */
export function errorLabel(error: string): { code: string; key: string | null } {
    const code = (error ?? "").split(":")[0].trim();
    const known = new Set([
        "AI_NO_PROVIDER",
        "SCHEDULE_KNOWLEDGE_UNBOUND",
        "SCHEDULE_TIMEOUT",
        "SCHEDULE_TASK_RUNNING",
        "SCHEDULE_PROMPT_NOT_FOUND",
        "SCHEDULE_PROMPT_VAR_MISSING",
        "SCHEDULE_ACTION_NO_PROMPT",
        "SCHEDULE_UNKNOWN_ACTION",
        "SCHEDULE_FRONTEND_UNAVAILABLE",
        "SCHEDULE_ACTION_PANIC",
        "SCHEDULE_TASK_NOT_FOUND",
        "FEEDS_EMPTY",
        "FEEDS_ALL_FAILED",
    ]);
    return { code, key: known.has(code) ? `schedule.errCode.${code}` : null };
}

/** 新建任务的空白草稿。 */
export function blankTask(now = new Date()): TaskInput {
    return {
        name: "",
        frequency: defaultFrequency("daily", now),
        action: { id: "ai_prompt", params: { promptId: "", instruction: "", title: "" } },
        enabled: true,
        runIfMissed: false,
    };
}
