/** 资讯状态和 SQLite 阅读缓存；运行中的请求不持久化。 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";
import { mergedSources } from "@/sources/custom";
import type { SourceEntry } from "@/sources/types";

export const FAVORITES_ID = "__favorites__";
interface FeedsState {
    activeId: string;
    entriesBySource: Record<string, SourceEntry[]>;
    loading: Record<string, boolean | undefined>;
    error: Record<string, string | undefined>;
    lastFetchedAt: Record<string, number | undefined>;
    lastAttemptDay: Record<string, string | undefined>;
    selected: SourceEntry | null;
    initialize: () => Promise<void>;
    selectSource: (id: string) => void;
    refresh: (id?: string) => Promise<void>;
    refreshAll: () => Promise<void>;
    refreshDaily: (now?: Date) => Promise<void>;
    seedCache: (id: string, entries: SourceEntry[]) => void;
    selectEntry: (entry: SourceEntry | null) => void;
}
function localDay(now: Date): string {
    return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}
const pending = new Map<string, Promise<void>>();
let dailyPending: Promise<void> | null = null;
let initialized = false;
export const useFeeds = create<FeedsState>()(persist((set, get) => {
    const refreshBatch = (now: Date, force: boolean): Promise<void> => {
        if (dailyPending) return dailyPending;
        const day = localDay(now);
        const claimed = new Set<string>();
        const worker = async () => {
            // Refresh every source; re-read the catalog to respect subscription edits mid-batch.
            while (true) {
                const source = mergedSources().find(item => !claimed.has(item.id) && (force || get().lastAttemptDay[item.id] !== day));
                if (!source) return;
                claimed.add(source.id);
                const request = get().refresh(source.id);
                set(state => ({ lastAttemptDay: { ...state.lastAttemptDay, [source.id]: day } }));
                await request;
            }
        };
        const request = Promise.all([worker(), worker()]).then(() => undefined);
        dailyPending = request;
        void request.finally(() => { dailyPending = null; });
        return request;
    };
    return {
    activeId: "github-trending",
    entriesBySource: {}, loading: {}, error: {}, lastFetchedAt: {}, lastAttemptDay: {}, selected: null,
    initialize: () => {
        if (!initialized) get().selectSource(mergedSources()[0]?.id ?? FAVORITES_ID);
        return pending.get(get().activeId) ?? Promise.resolve();
    },
    selectSource: id => {
        initialized = true;
        set({ activeId: id, selected: null });
        if (id !== FAVORITES_ID && !get().entriesBySource[id] && get().lastAttemptDay[id] !== localDay(new Date()))
            void get().refresh(id);
    },
    seedCache: (id, entries) => set(state => ({
        entriesBySource: { ...state.entriesBySource, [id]: entries.slice(0, 50) },
        lastFetchedAt: { ...state.lastFetchedAt, [id]: Date.now() },
        lastAttemptDay: { ...state.lastAttemptDay, [id]: localDay(new Date()) },
        error: { ...state.error, [id]: undefined },
    })),
    refresh: id => {
        const sourceId = id ?? get().activeId;
        const running = pending.get(sourceId);
        if (running) return running;
        const adapter = mergedSources().find(source => source.id === sourceId);
        if (!adapter) return Promise.resolve();
        set(state => ({
            loading: { ...state.loading, [sourceId]: true },
            error: { ...state.error, [sourceId]: undefined },
            lastAttemptDay: { ...state.lastAttemptDay, [sourceId]: localDay(new Date()) },
        }));
        const request = (async () => {
            try {
                const entries = await adapter.fetch();
                // A removed or changed subscription must not resurrect its old cache.
                if (mergedSources().find(source => source.id === sourceId)?.homepage !== adapter.homepage) return;
                set(state => ({
                    entriesBySource: { ...state.entriesBySource, [sourceId]: entries.slice(0, 50) },
                    lastFetchedAt: { ...state.lastFetchedAt, [sourceId]: Date.now() },
                }));
            } catch (cause) {
                set(state => ({ error: { ...state.error, [sourceId]: cause instanceof Error ? cause.message : String(cause) } }));
            } finally {
                set(state => ({ loading: { ...state.loading, [sourceId]: false } }));
            }
        })();
        pending.set(sourceId, request);
        void request.finally(() => pending.delete(sourceId));
        return request;
    },
    refreshDaily: (now = new Date()) => refreshBatch(now, false),
    refreshAll: () => refreshBatch(new Date(), true),
    selectEntry: selected => set({ selected }),
};
}, {
    name: 'feed-cache', version: 1, storage: createJSONStorage(() => tauriJsonStorage),
    partialize: state => {
        const ids = new Set(mergedSources().map(source => source.id));
        const keep = <T,>(values: Record<string, T>) => Object.fromEntries(Object.entries(values).filter(([id]) => ids.has(id)));
        return { entriesBySource: keep(state.entriesBySource), lastFetchedAt: keep(state.lastFetchedAt), lastAttemptDay: keep(state.lastAttemptDay), error: keep(state.error) };
    },
}));
