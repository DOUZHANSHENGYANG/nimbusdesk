/**
 * 定时任务的运行期接线：两条事件。
 *
 * - `schedule://action`：Rust 引擎到点了，但动作的真正实现在前端
 *   （刷新信息源 = `src/sources/*`，备份 = `src/features/settings/backup.ts`）。
 *   我们跑完那条既有链路，再把结果回调给引擎 —— 不在 Rust 里抄第二份实现。
 * - `schedule://ran`：某次运行结束，右上角给一条 toast。桌面应用"在后台自己跑了"
 *   这件事必须让用户看得见，否则和没跑没区别。
 */
import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { flushAllStorage } from "@/lib/storage";
import { getDataDir, inTauri, writeBackup } from "@/lib/tauri";
import { mergedSources } from "@/sources/custom";
import { useFeeds } from "@/stores/feeds";
import { buildBackup, joinPath } from "@/features/settings/backup";
import { reportActionResult } from "./api";
import { errorLabel, type HistoryEntry, type Translate } from "./core";

interface ActionRequest {
    runId: string;
    actionId: string;
    taskId: string;
    taskName: string;
    params: Record<string, unknown>;
}

function messageOf(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

/** 刷新信息源：全部，或某一个源。复用资讯页那条刷新链路。 */
async function refreshFeeds(request: ActionRequest, t: Translate): Promise<string> {
    const sourceId = String(request.params.sourceId ?? "").trim();
    const ids = sourceId ? [sourceId] : mergedSources().map((source) => source.id);
    if (!ids.length) throw new Error("FEEDS_EMPTY");
    if (sourceId && !mergedSources().some((source) => source.id === sourceId)) {
        throw new Error(`FEEDS_EMPTY: ${sourceId}`);
    }
    const before = { ...useFeeds.getState().error };
    // refresh 自己吞掉单个源的失败并记进 state.error，所以失败要看 error 表，不看 reject
    if (sourceId) await useFeeds.getState().refresh(sourceId);
    else await useFeeds.getState().refreshAll();
    const after = useFeeds.getState();
    const failed = ids.filter((id) => after.error[id] && before[id] !== after.error[id]);
    if (failed.length === ids.length) throw new Error(`FEEDS_ALL_FAILED: ${after.error[failed[0]] ?? ""}`);
    return t("schedule.note.feedsRefreshed", { ok: ids.length - failed.length, total: ids.length });
}

/** 备份：复用设置页的打包实现，只是不弹「另存为」，写到数据目录的 backups/ 下。 */
async function runBackup(): Promise<string> {
    await flushAllStorage();
    const file = await buildBackup({ includeDirs: true });
    const directory = await getDataDir();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const path = joinPath(joinPath(directory, "backups"), `nimbusdesk-auto-${stamp}.json`);
    const saved = await writeBackup(path, JSON.stringify(file, null, 2));
    return saved.path;
}

async function runDelegated(request: ActionRequest, t: Translate): Promise<string> {
    if (request.actionId === "refresh_feeds") return refreshFeeds(request, t);
    if (request.actionId === "backup") return runBackup();
    throw new Error(`SCHEDULE_UNKNOWN_ACTION: ${request.actionId}`);
}

export function ScheduleRuntime() {
    const { t } = useTranslation();
    // 事件回调闭包要拿到当前语言，但又不想因为换语言而重新订阅
    const translate = useRef<Translate>(t as unknown as Translate);
    translate.current = t as unknown as Translate;

    useEffect(() => {
        if (!inTauri) return;
        const stops = [
            listen<HistoryEntry>("schedule://ran", ({ payload }) => {
                const text = translate.current;
                const code = payload.error ? errorLabel(payload.error).code : "";
                if (payload.status === "success") {
                    toast.success(text("schedule.toast.success", { name: payload.taskName, note: payload.note ?? "" }));
                } else if (payload.status === "failed") {
                    toast.error(text("schedule.toast.failed", { name: payload.taskName, code }));
                } else {
                    toast.warning(text("schedule.toast.skipped", { name: payload.taskName }));
                }
            }),
            listen<ActionRequest>("schedule://action", async ({ payload }) => {
                try {
                    const note = await runDelegated(payload, translate.current);
                    await reportActionResult(payload.runId, true, note);
                } catch (cause) {
                    // 回调失败只记日志：Rust 侧要么在等（我们已尽力），要么已按超时记过失败
                    await reportActionResult(payload.runId, false, undefined, messageOf(cause)).catch(() => undefined);
                }
            }),
        ];
        return () => {
            for (const stop of stops) void stop.then((off) => off()).catch(() => undefined);
        };
    }, []);

    return null;
}
