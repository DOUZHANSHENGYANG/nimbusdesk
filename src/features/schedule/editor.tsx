/**
 * 新建 / 编辑一个定时任务。
 *
 * 频率选择器与动作参数表单都是**由声明驱动**的：
 * 频率六种是固定枚举（照抄 `model.rs` 的形状），动作参数则读 Rust 给的
 * `fields` 声明 —— 所以后端加一个动作，这个文件不用动。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/motion/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { inTauri } from "@/lib/tauri";
import { chatWithProvider } from "@/features/ai/client";
import { mergedSources } from "@/sources/custom";
import {
    FREQUENCY_KINDS,
    blankTask,
    defaultFrequency,
    describeFrequency,
    formatStamp,
    validateTask,
    type ActionInfo,
    type Frequency,
    type FrequencyKind,
    type Task,
    type TaskInput,
    type Translate,
} from "./core";
import { previewFrequency } from "./api";

interface Draft extends TaskInput { id: string }

function draftOf(task: Task | null): Draft {
    if (!task) return { ...blankTask(), id: "" };
    const { id, name, frequency, action, enabled, runIfMissed } = task;
    return { id, name, frequency, action, enabled, runIfMissed };
}

/** 频率的六种参数形态。 */
function FrequencyFields({ frequency, onChange }: { frequency: Frequency; onChange: (next: Frequency) => void }) {
    const { t } = useTranslation();
    switch (frequency.kind) {
        case "once":
            return (
                <div className="schedule-field">
                    <Label htmlFor="schedule-once">{t("schedule.field.dateTime")}</Label>
                    <Input
                        id="schedule-once"
                        type="datetime-local"
                        value={frequency.at}
                        onChange={(event) => onChange({ kind: "once", at: event.target.value })}
                    />
                </div>
            );
        case "daily":
            return <TimeField value={frequency.time} onChange={(time) => onChange({ kind: "daily", time })} />;
        case "weekly":
            return (
                <>
                    <div className="schedule-field">
                        <Label>{t("schedule.field.weekdays")}</Label>
                        <div className="schedule-chips">
                            {[1, 2, 3, 4, 5, 6, 7].map((day) => {
                                const active = frequency.weekdays.includes(day);
                                return (
                                    <button
                                        key={day}
                                        type="button"
                                        data-active={active}
                                        className="schedule-chip"
                                        aria-pressed={active}
                                        onClick={() => onChange({
                                            kind: "weekly",
                                            time: frequency.time,
                                            weekdays: active
                                                ? frequency.weekdays.filter((item) => item !== day)
                                                : [...frequency.weekdays, day].sort((a, b) => a - b),
                                        })}
                                    >
                                        {t(`schedule.weekday.${day}`)}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <TimeField value={frequency.time} onChange={(time) => onChange({ kind: "weekly", weekdays: frequency.weekdays, time })} />
                </>
            );
        case "monthly":
            return (
                <>
                    <div className="schedule-field">
                        <Label htmlFor="schedule-day">{t("schedule.field.day")}</Label>
                        <Input
                            id="schedule-day"
                            type="number"
                            min={1}
                            max={31}
                            value={frequency.day}
                            onChange={(event) => onChange({ kind: "monthly", day: Number(event.target.value), time: frequency.time })}
                        />
                    </div>
                    <TimeField value={frequency.time} onChange={(time) => onChange({ kind: "monthly", day: frequency.day, time })} />
                </>
            );
        case "yearly":
            return (
                <>
                    <div className="schedule-field">
                        <Label>{t("schedule.field.month")}</Label>
                        <Select
                            value={String(frequency.month)}
                            onValueChange={(value) => onChange({ kind: "yearly", month: Number(value), day: frequency.day, time: frequency.time })}
                        >
                            <SelectTrigger className="w-full" aria-label={t("schedule.field.month")}>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
                                    <SelectItem key={month} value={String(month)}>
                                        {t("schedule.field.monthValue", { month })}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="schedule-field">
                        <Label htmlFor="schedule-year-day">{t("schedule.field.day")}</Label>
                        <Input
                            id="schedule-year-day"
                            type="number"
                            min={1}
                            max={31}
                            value={frequency.day}
                            onChange={(event) => onChange({ kind: "yearly", month: frequency.month, day: Number(event.target.value), time: frequency.time })}
                        />
                    </div>
                    <TimeField value={frequency.time} onChange={(time) => onChange({ kind: "yearly", month: frequency.month, day: frequency.day, time })} />
                </>
            );
        case "interval":
            return (
                <div className="schedule-field">
                    <Label htmlFor="schedule-minutes">{t("schedule.field.minutes")}</Label>
                    <Input
                        id="schedule-minutes"
                        type="number"
                        min={1}
                        max={1440}
                        value={frequency.minutes}
                        onChange={(event) => onChange({ kind: "interval", minutes: Number(event.target.value) })}
                    />
                </div>
            );
    }
}

function TimeField({ value, onChange }: { value: string; onChange: (time: string) => void }) {
    const { t } = useTranslation();
    return (
        <div className="schedule-field">
            <Label htmlFor="schedule-time">{t("schedule.field.time")}</Label>
            <Input id="schedule-time" type="time" value={value} onChange={(event) => onChange(event.target.value)} />
        </div>
    );
}

/** 动作参数：按 `fields` 声明渲染，不加动作就不改这里。 */
function ActionFields({
    action,
    params,
    onChange,
}: {
    action: ActionInfo | undefined;
    params: Record<string, unknown>;
    onChange: (next: Record<string, unknown>) => void;
}) {
    const { t } = useTranslation();
    const [prompts, setPrompts] = useState<{ id: string; title: string }[]>([]);
    const sources = useMemo(() => mergedSources().map((source) => ({ id: source.id, name: source.name })), []);

    useEffect(() => {
        if (!inTauri) return;
        // 复用工具箱的提示词数据（只读）
        void invoke<{ id: string; title: string }[]>("list_prompts")
            .then(setPrompts)
            .catch(() => setPrompts([]));
    }, []);

    if (!action || !action.fields.length) {
        return <p className="text-xs text-muted-foreground">{t("schedule.action.noFields")}</p>;
    }

    const set = (name: string, value: unknown) => onChange({ ...params, [name]: value });

    return (
        <>
            {action.fields.map((field) => {
                const value = params[field.name];
                const text = typeof value === "string" ? value : "";
                const label = t(field.label);
                return (
                    <div key={field.name} className="schedule-field">
                        <Label htmlFor={`schedule-${field.name}`}>{label}</Label>
                        <div className="min-w-0 space-y-1">
                            {field.type === "textarea" ? (
                                <Textarea
                                    id={`schedule-${field.name}`}
                                    rows={3}
                                    value={text}
                                    onChange={(event) => set(field.name, event.target.value)}
                                />
                            ) : field.type === "prompt" ? (
                                prompts.length ? (
                                    <Select
                                        value={text || "__none__"}
                                        onValueChange={(next) => set(field.name, next === "__none__" ? "" : next)}
                                    >
                                        <SelectTrigger className="w-full" aria-label={label}>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="__none__">{t("schedule.opt.noPrompt")}</SelectItem>
                                            {prompts.map((prompt) => (
                                                <SelectItem key={prompt.id} value={prompt.id}>
                                                    {prompt.title || prompt.id}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                ) : (
                                    <Input
                                        id={`schedule-${field.name}`}
                                        value={text}
                                        placeholder={t("schedule.opt.promptIdPlaceholder")}
                                        onChange={(event) => set(field.name, event.target.value)}
                                    />
                                )
                            ) : field.type === "source" ? (
                                <Select
                                    value={text || "__all__"}
                                    onValueChange={(next) => set(field.name, next === "__all__" ? "" : next)}
                                >
                                    <SelectTrigger className="w-full" aria-label={label}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="__all__">{t("schedule.opt.allSources")}</SelectItem>
                                        {sources.map((source) => (
                                            <SelectItem key={source.id} value={source.id}>
                                                {source.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            ) : (
                                <Input
                                    id={`schedule-${field.name}`}
                                    value={text}
                                    onChange={(event) => set(field.name, event.target.value)}
                                />
                            )}
                            {field.hint ? <p className="text-xs text-muted-foreground">{t(field.hint)}</p> : null}
                        </div>
                    </div>
                );
            })}
        </>
    );
}

type AiTaskDraft = {
    name?: string;
    frequency?: { kind?: string } & Record<string, unknown>;
    action?: { id?: string; params?: Record<string, unknown> };
};

/** 模型有时会包 ```json 围栏或加一句解释：只取最外层 JSON 对象。 */
function parseTaskJson(text: string): AiTaskDraft {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : text;
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("AI 没有返回可解析的任务配置");
    return JSON.parse(body.slice(start, end + 1)) as AiTaskDraft;
}

export function ScheduleEditor({
    task,
    actions,
    onClose,
    onSaved,
}: {
    task: Task | null;
    actions: ActionInfo[];
    onClose: () => void;
    onSaved: (task: Task) => void;
}) {
    const { t } = useTranslation();
    const translate = t as unknown as Translate;
    const [draft, setDraft] = useState<Draft>(() => draftOf(task));
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [preview, setPreview] = useState<string[]>([]);
    const [aiText, setAiText] = useState("");
    const [aiBusy, setAiBusy] = useState(false);
    const [aiError, setAiError] = useState<string | null>(null);

    const action = actions.find((item) => item.id === draft.action.id);

    // 下次运行时刻由 Rust 算（这里只请求，不自己算）：防抖到停止输入之后
    useEffect(() => {
        if (validateTask(draft)) {
            setPreview([]);
            return;
        }
        let alive = true;
        const timer = setTimeout(() => {
            void previewFrequency(draft.frequency, 3)
                .then((next) => { if (alive) setPreview(next); })
                .catch(() => { if (alive) setPreview([]); });
        }, 250);
        return () => { alive = false; clearTimeout(timer); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [JSON.stringify(draft.frequency), JSON.stringify(draft.action.params), draft.name]);

    /**
     * 用一句话生成任务：模型只负责「翻译」成人话之外的配置，落到已有字段上，
     * 生成后仍走同一套校验与保存 —— AI 出错时用户还能手改。
     */
    const aiGenerate = async () => {
        const brief = aiText.trim();
        if (!brief || aiBusy) return;
        setAiBusy(true);
        setAiError(null);
        try {
            const now = new Date();
            const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
            const reply = await chatWithProvider([
                {
                    role: "system",
                    content: [
                        "你是「云台」的定时任务配置助手。把用户的一句话变成 JSON，只输出 JSON，不要解释。",
                        "可用动作 id：ai_prompt（让 AI 执行提示词或指令）、refresh_feeds（刷新资讯源）、backup（备份）。",
                        "频率 kind 与字段：once{at:\"YYYY-MM-DDTHH:mm\"}、daily{time:\"HH:mm\"}、weekly{weekdays:[1-7],time}、monthly{day:1-31,time}、yearly{month:1-12,day,time}、interval{minutes}。",
                        "输出形状：{\"name\":\"任务名\",\"frequency\":{\"kind\":\"daily\",\"time\":\"09:00\"},\"action\":{\"id\":\"ai_prompt\",\"params\":{\"promptId\":\"\",\"instruction\":\"给 AI 的完整指令\"}}}",
                        "规则：没提时间用 09:00；每周一用 weekly [1]；每 30 分钟用 interval 30；动作默认 ai_prompt，instruction 要把用户的意思写完整。",
                        `当前本地时间：${stamp}。`,
                    ].join("\n"),
                },
                { role: "user", content: brief },
            ]);
            const parsed = parseTaskJson(reply);
            const kind = (["once", "daily", "weekly", "monthly", "yearly", "interval"] as FrequencyKind[]).includes(
                parsed.frequency?.kind as FrequencyKind,
            )
                ? (parsed.frequency!.kind as FrequencyKind)
                : "daily";
            const safeTime = (value: unknown) =>
                typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : "09:00";
            const f = parsed.frequency ?? {};
            let frequency: Frequency;
            switch (kind) {
                case "once":
                    frequency = {
                        kind,
                        at: typeof f.at === "string" && f.at
                            ? f.at
                            : (defaultFrequency("once") as Extract<Frequency, { kind: "once" }>).at,
                    };
                    break;
                case "weekly": {
                    const days = Array.isArray(f.weekdays)
                        ? (f.weekdays as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
                        : [];
                    frequency = { kind, weekdays: days.length ? [...new Set(days)].sort((a, b) => a - b) : [1], time: safeTime(f.time) };
                    break;
                }
                case "monthly": {
                    const day = Number(f.day);
                    frequency = { kind, day: Number.isInteger(day) && day >= 1 && day <= 31 ? day : 1, time: safeTime(f.time) };
                    break;
                }
                case "yearly": {
                    const month = Number(f.month);
                    const day = Number(f.day);
                    frequency = {
                        kind,
                        month: Number.isInteger(month) && month >= 1 && month <= 12 ? month : 1,
                        day: Number.isInteger(day) && day >= 1 && day <= 31 ? day : 1,
                        time: safeTime(f.time),
                    };
                    break;
                }
                case "interval": {
                    const minutes = Number(f.minutes);
                    frequency = { kind, minutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 30 };
                    break;
                }
                default:
                    frequency = { kind: "daily", time: safeTime(f.time) };
            }
            const wanted = parsed.action?.id;
            const actionId = actions.some((item) => item.id === wanted) ? wanted! : "ai_prompt";
            const spec = actions.find((item) => item.id === actionId);
            const params: Record<string, unknown> = {};
            for (const field of spec?.fields ?? []) {
                const value = parsed.action?.params?.[field.name];
                if (value !== undefined && value !== null) params[field.name] = value;
            }
            if (actionId === "ai_prompt") {
                if (typeof params.instruction !== "string" || !params.instruction.trim()) params.instruction = brief;
                if (typeof params.promptId !== "string") params.promptId = "";
            }
            const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim().slice(0, 100) : draft.name || brief.slice(0, 30);
            setDraft({ ...draft, name, frequency, action: { id: actionId, params } });
        } catch (cause) {
            setAiError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setAiBusy(false);
        }
    };

    const save = async () => {
        const problem = validateTask(draft);
        if (problem) {
            setError(problem);
            return;
        }
        setSaving(true);
        try {
            const saved = await invoke<Task>("schedule_save", { task: draft });
            onSaved(saved);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent className="max-h-[86vh] overflow-y-auto sm:max-w-[620px]">
                <DialogHeader>
                    <DialogTitle>{t(draft.id ? "schedule.editTask" : "schedule.newTask")}</DialogTitle>
                </DialogHeader>

                <div className="space-y-4 py-1">
                    <div className="rounded-lg border border-border bg-muted/20 p-3">
                        <Label className="flex items-center gap-1.5">
                            <Sparkles className="size-3.5 text-primary" />
                            {t("schedule.ai.title")}
                        </Label>
                        <Textarea
                            className="mt-2"
                            rows={2}
                            value={aiText}
                            placeholder={t("schedule.ai.placeholder")}
                            onChange={(event) => setAiText(event.target.value)}
                        />
                        <div className="mt-2 flex items-center gap-2">
                            <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">{t("schedule.ai.hint")}</p>
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={aiBusy || !aiText.trim()}
                                onClick={() => void aiGenerate()}
                            >
                                {aiBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                                {t(aiBusy ? "schedule.ai.working" : "schedule.ai.generate")}
                            </Button>
                        </div>
                        {aiError ? <p className="text-xs text-destructive">{aiError}</p> : null}
                    </div>

                    <div className="schedule-field">
                        <Label htmlFor="schedule-name">{t("schedule.field.name")}</Label>
                        <Input
                            id="schedule-name"
                            value={draft.name}
                            maxLength={100}
                            placeholder={t("schedule.field.namePlaceholder")}
                            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                        />
                    </div>

                    <div className="space-y-3">
                        <Label>{t("schedule.field.frequency")}</Label>
                        <Tabs
                            variant="segment"
                            value={draft.frequency.kind}
                            onValueChange={(kind) => {
                                if (kind !== draft.frequency.kind) {
                                    setDraft({ ...draft, frequency: defaultFrequency(kind as FrequencyKind) });
                                }
                            }}
                        >
                            <TabsList>
                                {FREQUENCY_KINDS.map((kind) => (
                                    <TabsTrigger key={kind} value={kind}>
                                        {t(`schedule.kind.${kind}`)}
                                    </TabsTrigger>
                                ))}
                            </TabsList>
                        </Tabs>
                        <FrequencyFields
                            frequency={draft.frequency}
                            onChange={(frequency) => setDraft({ ...draft, frequency })}
                        />
                        <p className="text-xs text-muted-foreground" data-testid="schedule-summary">
                            {describeFrequency(draft.frequency, translate)}
                        </p>
                        <div className="space-y-1 rounded-[var(--pr-radius-sm)] bg-muted/50 p-2.5">
                            <p className="text-xs font-medium text-muted-foreground">{t("schedule.preview.title")}</p>
                            {preview.length ? (
                                <div className="schedule-preview text-xs tabular-nums text-foreground">
                                    {preview.map((item) => <span key={item}>{formatStamp(item)}</span>)}
                                </div>
                            ) : (
                                <p className="text-xs text-muted-foreground">{t("schedule.preview.empty")}</p>
                            )}
                        </div>
                    </div>

                    <div className="space-y-3">
                        <div className="schedule-field">
                            <Label>{t("schedule.field.action")}</Label>
                            <Select
                                value={draft.action.id}
                                onValueChange={(id) => setDraft({ ...draft, action: { id, params: {} } })}
                            >
                                <SelectTrigger className="w-full" aria-label={t("schedule.field.action")}>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {actions.map((item) => (
                                        <SelectItem key={item.id} value={item.id}>
                                            {t(item.label)}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <ActionFields
                            action={action}
                            params={draft.action.params}
                            onChange={(params) => setDraft({ ...draft, action: { id: draft.action.id, params } })}
                        />
                    </div>

                    <div className="space-y-2 rounded-[var(--pr-radius-sm)] bg-muted/50 p-2.5">
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-sm">{t("schedule.enable")}</span>
                            <Switch
                                checked={draft.enabled}
                                onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
                                ariaLabel={t("schedule.enable")}
                            />
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-sm">
                                {t("schedule.runIfMissed")}
                                <span className="mt-0.5 block text-xs text-muted-foreground">{t("schedule.runIfMissedHint")}</span>
                            </span>
                            <Switch
                                checked={draft.runIfMissed}
                                onCheckedChange={(runIfMissed) => setDraft({ ...draft, runIfMissed })}
                                ariaLabel={t("schedule.runIfMissed")}
                            />
                        </div>
                    </div>

                    {error ? (
                        <p role="alert" className="text-sm text-destructive">
                            {error.startsWith("schedule.") ? t(error) : error}
                        </p>
                    ) : null}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={saving}>
                        {t("schedule.cancel")}
                    </Button>
                    <Button onClick={() => void save()} disabled={saving}>
                        {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                        {t("schedule.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
