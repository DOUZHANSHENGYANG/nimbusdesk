import { useEffect } from "react";
import { useFeeds } from "@/stores/feeds";
import { useCustomFeeds } from "@/stores/custom-feeds";

/** Main-window runtime: startup and tray/window focus, including the first open after midnight. */
export function startFeedsRuntime(target: EventTarget = window): () => void {
    let disposed = false;
    let started = false;
    const run = () => {
        if (!disposed) void useFeeds.getState().refreshDaily();
    };
    const ready = () => {
        if (disposed || started || !useFeeds.persist.hasHydrated() || !useCustomFeeds.persist.hasHydrated()) return;
        started = true;
        run();
    };
    const offCache = useFeeds.persist.onFinishHydration(ready);
    const offSubscriptions = useCustomFeeds.persist.onFinishHydration(ready);
    const offChanges = useCustomFeeds.subscribe((state, previous) => {
        if (started && state.feeds !== previous.feeds) run();
    });
    const focus = () => { if (started) run(); else ready(); };
    target.addEventListener('focus', focus);
    ready();
    return () => { disposed = true; offCache(); offSubscriptions(); offChanges(); target.removeEventListener('focus', focus); };
}

export function FeedsRuntime() {
    useEffect(() => startFeedsRuntime(), []);
    return null;
}
