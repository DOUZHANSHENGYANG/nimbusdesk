import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useFeeds } from "@/stores/feeds";
import { toEntry, useSubscriptions, type FeedItem } from "./subscriptions";
import { inTauri } from "@/lib/tauri";

/** Main-window runtime: startup and tray/window focus, including the first open after midnight. */
export function startFeedsRuntime(target: EventTarget = window): () => void {
    let disposed = false;
    let started = false;
    const run = () => {
        if (!disposed) void useFeeds.getState().refreshDaily();
    };
    const ready = () => {
        if (disposed || started || !useFeeds.persist.hasHydrated()) return;
        started = true;
        void useSubscriptions.getState().load().then(run);
    };
    const offCache = useFeeds.persist.onFinishHydration(ready);
    // 后台采集线程跑完一个源：只换这一源的缓存。这里不能再调 refresh()，
    // 那会再跑一次采集，事件自己喂自己。
    const unlisten = inTauri
        ? listen<{ sourceId?: string }>("feeds://updated", ({ payload }) => {
            const sourceId = payload?.sourceId;
            if (!sourceId || !started || !useFeeds.getState().entriesBySource[sourceId]) return;
            void invoke<FeedItem[]>("feeds_items", { query: { sourceId, limit: 100 } })
                .then(items => useFeeds.getState().seedCache(sourceId, items.map(toEntry)))
                .catch(() => undefined);
        })
        : Promise.resolve(() => undefined);
    const focus = () => { if (started) run(); else ready(); };
    target.addEventListener('focus', focus);
    ready();
    return () => {
        disposed = true;
        offCache();
        void unlisten.then(stop => stop());
        target.removeEventListener('focus', focus);
    };
}

export function FeedsRuntime() {
    useEffect(() => startFeedsRuntime(), []);
    return null;
}
