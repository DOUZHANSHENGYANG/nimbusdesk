/**
 * 定时任务页。
 *
 * 页面只做三件事：把任务表列出来、把编辑器打开、把历史摆出来。
 * 「下次运行时刻」全部读 Rust 存的 `nextRun`（`schedule_preview` 只用于编辑时的预览），
 * 前端不自己算日历 —— 两处各算一套迟早会给出两个答案。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { Clock, Loader2, Pencil, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/motion/switch";
import { inTauri, revealInExplorer } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { clearHistory, deleteTask, loadSnapshot, runTaskNow, setTaskEnabled } from "./api";
import { describeFrequency, errorLabel, formatStamp, statusLabel, type Snapshot, type Task, type Translate } from "./core";
import { ScheduleEditor } from "./editor";
import "./schedule.css";

/** 三态徽章的配色只用语义 token */
function statusTone(status: string): string {
    if (status === "success") return "bg-success/12 text-success";
    if (status === "failed") return "bg-destructive/12 text-destructive";
    return "bg-warning/14 text-warning";
}

function StatusBadge({ status }: { status: string }) {
    const { t } = useTranslation();
    return (
        <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-xs font-medium", statusTone(status))}>
            {t(statusLabel(status))}
        </span>
    );
}

export function SchedulePage() {
    const { t } = useTranslation();
    const translate = t as unknown as Translate;
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [editing, setEditing] = useState<{ task: Task | null } | null>(null);
    const [pendingDelete, setPendingDelete] = useState<Task | null>(null);

    const reload = useCallback(async () => {
        if (!inTauri) {
            setSnapshot({ tasks: [], history: [], actions: [] });
            return;
        }
        try {
            setSnapshot(await loadSnapshot());
            setError(null);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }, []);

    useEffect(() => { void reload(); }, [reload]);

    // 后台跑完一轮就刷新这张表 —— 用户不该靠手动刷新才知道任务跑过了
    useEffect(() => {
        if (!inTauri) return;
        const stop = listen("schedule://ran", () => { void reload(); });
        return () => { void stop.then((off) => off()).catch(() => undefined); };
    }, [reload]);

    const tasks = snapshot?.tasks ?? [];
    const history = snapshot?.history ?? [];
    const actions = snapshot?.actions ?? [];

    const runNow = async (task: Task) => {
        setBusy(task.id);
        try {
            const entry = await runTaskNow(task.id);
            if (entry.status === "success") toast.success(t("schedule.toast.success", { name: task.name, note: entry.note ?? "" }));
            else toast.error(t("schedule.toast.failed", { name: task.name, code: entry.error ? errorLabel(entry.error).code : "" }));
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            const label = errorLabel(message);
            toast.error(label.key ? t(label.key) : message);
        } finally {
            setBusy(null);
            await reload();
        }
    };

    const toggle = async (task: Task, enabled: boolean) => {
        try {
            await setTaskEnabled(task.id, enabled);
        } catch (cause) {
            toast.error(cause instanceof Error ? cause.message : String(cause));
        }
        await reload();
    };

    const remove = async (task: Task) => {
        setPendingDelete(null);
        try {
            await deleteTask(task.id);
            toast.success(t("schedule.toast.deleted", { name: task.name }));
        } catch (cause) {
            toast.error(cause instanceof Error ? cause.message : String(cause));
        }
        await reload();
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
                <div className="min-w-0 flex-1">
                    <h1 className="truncate text-sm font-semibold">{t("schedule.title")}</h1>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t("schedule.subtitle")}</p>
                </div>
                <Button variant="ghost" size="icon-sm" title={t("schedule.reload")} aria-label={t("schedule.reload")} onClick={() => void reload()}>
                    <RefreshCw className="size-4" />
                </Button>
                <Button size="sm" onClick={() => setEditing({ task: null })}>
                    <Plus className="size-4" />
                    {t("schedule.newTask")}
                </Button>
            </header>

            <div className="schedule-body">
                {/* 桌面应用的固有边界：说清楚，不假装它是系统计划任务 */}
                <p className="flex items-start gap-2 rounded-[var(--pr-radius-sm)] bg-muted/50 p-2.5 text-xs text-muted-foreground">
                    <Clock className="mt-px size-3.5 shrink-0" />
                    <span>{t("schedule.desktopNote")}</span>
                </p>

                {error ? (
                    <p role="alert" className="rounded-[var(--pr-radius-sm)] bg-destructive/8 p-2.5 text-xs break-all text-destructive">
                        {t("schedule.loadFailed")} {error}
                    </p>
                ) : null}

                <section className="space-y-1">
                    <div className="schedule-row text-xs font-medium text-muted-foreground" data-head>
                        <span>{t("schedule.col.name")}</span>
                        <span>{t("schedule.col.frequency")}</span>
                        <span>{t("schedule.col.nextRun")}</span>
                        <span>{t("schedule.col.last")}</span>
                        <span>{t("schedule.col.enabled")}</span>
                        <span className="text-right">{t("schedule.col.actions")}</span>
                    </div>

                    {tasks.length === 0 ? (
                        <div className="rounded-[var(--pr-radius-md)] bg-muted/40 p-6 text-center">
                            <p className="text-sm font-medium">{t("schedule.empty")}</p>
                            <p className="mt-1 text-xs text-muted-foreground">{t("schedule.emptyHint")}</p>
                        </div>
                    ) : tasks.map((task) => (
                        <div key={task.id} className="schedule-row border-b border-border/60 text-sm" data-body>
                            <span className="min-w-0 truncate font-medium" title={task.name}>
                                {task.name}
                                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                                    {t(task.action.id === "ai_prompt" ? "schedule.action.aiPrompt" : task.action.id === "refresh_feeds" ? "schedule.action.refreshFeeds" : "schedule.action.backup")}
                                </span>
                            </span>
                            <span className="min-w-0 truncate text-muted-foreground" title={describeFrequency(task.frequency, translate)}>
                                {describeFrequency(task.frequency, translate)}
                            </span>
                            <span className="truncate tabular-nums text-muted-foreground">
                                {formatStamp(task.nextRun) || t("schedule.never")}
                            </span>
                            <span className="truncate">
                                {task.lastStatus ? <StatusBadge status={task.lastStatus} /> : <span className="text-xs text-muted-foreground">{t("schedule.never")}</span>}
                            </span>
                            <span>
                                <Switch
                                    checked={task.enabled}
                                    onCheckedChange={(enabled) => void toggle(task, enabled)}
                                    ariaLabel={t("schedule.col.enabled")}
                                />
                            </span>
                            <span className="flex justify-end gap-1">
                                <Button variant="ghost" size="icon-sm" title={t("schedule.runNow")} aria-label={t("schedule.runNow")} disabled={busy === task.id} onClick={() => void runNow(task)}>
                                    {busy === task.id ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                                </Button>
                                <Button variant="ghost" size="icon-sm" title={t("schedule.edit")} aria-label={t("schedule.edit")} onClick={() => setEditing({ task })}>
                                    <Pencil className="size-4" />
                                </Button>
                                <Button variant="ghost" size="icon-sm" title={t("schedule.delete")} aria-label={t("schedule.delete")} onClick={() => setPendingDelete(task)}>
                                    <Trash2 className="size-4" />
                                </Button>
                            </span>
                        </div>
                    ))}
                </section>

                <section className="space-y-1">
                    <div className="flex items-center gap-2">
                        <h2 className="text-sm font-semibold">{t("schedule.history.title")}</h2>
                        <span className="text-xs text-muted-foreground">{t("schedule.history.limit")}</span>
                        <div className="flex-1" />
                        {history.length ? (
                            <Button variant="ghost" size="sm" onClick={() => { void clearHistory().then(reload); }}>
                                {t("schedule.history.clear")}
                            </Button>
                        ) : null}
                    </div>
                    {history.length === 0 ? (
                        <p className="rounded-[var(--pr-radius-md)] bg-muted/40 p-4 text-xs text-muted-foreground">
                            {t("schedule.history.empty")}
                        </p>
                    ) : history.map((entry) => (
                        <div key={entry.id} className="schedule-history-row text-xs" data-entry>
                            <span className="tabular-nums text-muted-foreground">{formatStamp(entry.at)}</span>
                            <span className="flex items-center gap-2">
                                <StatusBadge status={entry.status} />
                                <span className="tabular-nums text-muted-foreground">{entry.ms}ms</span>
                            </span>
                            <span className="min-w-0 space-y-0.5">
                                <span className="block truncate font-medium">{entry.taskName}</span>
                                {entry.reason ? (
                                    <span className="block text-muted-foreground">{t("schedule.history.reason")}：{entry.reason === "app-not-running" ? t("schedule.history.reasonAppNotRunning") : entry.reason}</span>
                                ) : null}
                                {entry.error ? (
                                    <span className="block break-all text-destructive">
                                        {errorLabel(entry.error).key ? t(errorLabel(entry.error).key!) : entry.error}
                                    </span>
                                ) : null}
                                {entry.note ? (
                                    <span className="flex min-w-0 items-center gap-2">
                                        <span className="min-w-0 truncate text-muted-foreground" title={entry.note}>{entry.note}</span>
                                        <Button variant="ghost" size="xs" onClick={() => { void revealInExplorer(entry.note!).catch(() => undefined); }}>
                                            {t("schedule.history.open")}
                                        </Button>
                                    </span>
                                ) : null}
                            </span>
                        </div>
                    ))}
                </section>
            </div>

            {editing ? (
                <ScheduleEditor
                    task={editing.task}
                    actions={actions}
                    onClose={() => setEditing(null)}
                    onSaved={(saved) => {
                        setEditing(null);
                        toast.success(t("schedule.toast.saved", { name: saved.name }));
                        void reload();
                    }}
                />
            ) : null}

            {pendingDelete ? (
                <Dialog open onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
                    <DialogContent className="sm:max-w-[380px]">
                        <DialogHeader>
                            <DialogTitle>{t("schedule.delete")}</DialogTitle>
                        </DialogHeader>
                        <p className="text-sm text-muted-foreground">{t("schedule.deleteConfirm", { name: pendingDelete.name })}</p>
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setPendingDelete(null)}>{t("schedule.cancel")}</Button>
                            <Button variant="destructive" onClick={() => void remove(pendingDelete)}>{t("schedule.delete")}</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            ) : null}
        </div>
    );
}
