/**
 * 资讯订阅（Rust 是真源）：源、条目状态、OPML 都在 `modules/feeds/state.json`。
 *
 * 这个 store 只缓存一份读到的副本，给侧栏和适配器用；条目本身仍由 `useFeeds`
 * 的阅读缓存承载（桌面挂件、收藏、AI 摘要都读那一份，不改）。
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import { tauriJsonStorage } from "@/lib/storage";
import type { SourceEntry } from "@/sources/types";
import { useCustomFeeds } from "@/stores/custom-feeds";

export type FeedKind = "rss" | "opencli" | "cn-social" | "searxng" | "page";

export interface FeedSource {
    id: string;
    kind: FeedKind;
    name: string;
    config: Record<string, unknown>;
    enabled: boolean;
    intervalMinutes: number;
    sortOrder: number;
    lastRunAt?: string | null;
    lastStatus?: string | null;
    lastError?: string | null;
    lastCount: number;
    createdAt: string;
}

export interface FeedItem {
    id: string;
    sourceId: string;
    sourceName: string;
    kind: string;
    channel: string;
    title: string;
    url: string;
    author: string;
    publishedAt?: string | null;
    summary: string;
    content: string;
    diff: string;
    read: boolean;
    starred: boolean;
    createdAt: string;
}

export interface SourceInput {
    id?: string;
    kind: FeedKind;
    name?: string;
    config: Record<string, unknown>;
    enabled?: boolean;
    intervalMinutes?: number;
}

interface SubscriptionsState {
    sources: FeedSource[];
    /** 任何会改变源清单的写操作都会 +1：`mergedSources()` 是同步函数，靠它触发重算。 */
    revision: number;
    loaded: boolean;
    load: () => Promise<void>;
    save: (input: SourceInput) => Promise<FeedSource>;
    remove: (id: string) => Promise<void>;
    reorder: (ids: string[]) => Promise<void>;
    move: (id: string, delta: number) => Promise<void>;
    patchItem: (id: string, patch: { read?: boolean; starred?: boolean }) => Promise<void>;
    markAllRead: (sourceId?: string) => Promise<number>;
    importOpml: (path: string) => Promise<FeedSource[]>;
    run: (id: string) => Promise<SourceEntry[]>;
}

let loading: Promise<void> | null = null;

export const useSubscriptions = create<SubscriptionsState>((set, get) => ({
    sources: [],
    revision: 0,
    loaded: false,
    load: () => {
        if (loading) return loading;
        loading = (async () => {
            try {
                await migrateLegacyRss();
                const sources = await invoke<FeedSource[]>("feeds_sources");
                set(state => ({ sources, loaded: true, revision: state.revision + 1 }));
            } catch {
                // 浏览器里没有 IPC：保持空清单，界面照常可用，只是没有订阅
                set({ loaded: true });
            } finally {
                loading = null;
            }
        })();
        return loading;
    },
    save: async input => {
        const source = await invoke<FeedSource>("feeds_save_source", { input });
        set(state => ({
            sources: state.sources.some(item => item.id === source.id)
                ? state.sources.map(item => item.id === source.id ? source : item)
                : [...state.sources, source],
            revision: state.revision + 1,
        }));
        return source;
    },
    remove: async id => {
        await invoke("feeds_delete_source", { id });
        set(state => ({ sources: state.sources.filter(item => item.id !== id), revision: state.revision + 1 }));
    },
    reorder: async ids => {
        const sources = await invoke<FeedSource[]>("feeds_reorder", { ids });
        set(state => ({ sources, revision: state.revision + 1 }));
    },
    move: async (id, delta) => {
        const sources = await invoke<FeedSource[]>("feeds_move", { id, delta });
        set(state => ({ sources, revision: state.revision + 1 }));
    },
    patchItem: async (id, patch) => {
        await invoke("feeds_patch_item", { id, read: patch.read ?? null, starred: patch.starred ?? null });
    },
    markAllRead: async sourceId => {
        const changed = await invoke<number>("feeds_mark_all_read", { sourceId: sourceId ?? null });
        return changed;
    },
    importOpml: async path => {
        const sources = await invoke<FeedSource[]>("feeds_import_opml", { path });
        set(state => ({ sources, revision: state.revision + 1 }));
        return sources;
    },
    run: async id => {
        const items = await invoke<FeedItem[]>("feeds_run_source", { id });
        // 跑完顺带刷新一次源清单（lastRunAt / lastError 变了）
        void get().load();
        return items.map(toEntry);
    },
}));

/**
 * 侧栏顺序与可见性：内置热榜和自建订阅混在一条列表里，所以顺序只能存在前端。
 * Rust 源另有 sortOrder，但那份只服务于「没有本机顺序时」的兜底。
 */
interface FeedOrderState {
    order: string[];
    hidden: string[];
    setOrder: (ids: string[]) => void;
    hide: (id: string) => void;
    restore: () => void;
}

export const useFeedOrder = create<FeedOrderState>()(
    persist(
        set => ({
            order: [],
            hidden: [],
            setOrder: ids => set({ order: ids }),
            hide: id => set(state => ({ hidden: state.hidden.includes(id) ? state.hidden : [...state.hidden, id] })),
            restore: () => set({ order: [], hidden: [] }),
        }),
        { name: "feed-order", storage: createJSONStorage(() => tauriJsonStorage), version: 1 },
    ),
);

/** 把 Rust 条目映射成统一的 SourceEntry；`state` 让阅读器能回写已读/收藏。 */export function toEntry(item: FeedItem): SourceEntry {
    const pubDate = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
    const info = [item.author, Number.isNaN(pubDate) ? "" : new Date(pubDate).toISOString().slice(0, 10)]
        .filter(Boolean)
        .join(" · ");
    return {
        id: item.id,
        title: item.title,
        url: item.url,
        pubDate: Number.isNaN(pubDate) ? undefined : pubDate,
        content: item.content ? { format: "text", value: item.content } : undefined,
        extra: { info: info || undefined, hover: item.summary || undefined },
        state: { itemId: item.id, read: item.read, starred: item.starred, diff: item.diff },
    };
}

export function sourceLabel(source: FeedSource): string {
    const config = source.config ?? {};
    const url = typeof config.url === "string" ? config.url : "";
    const site = typeof config.site === "string" ? config.site : "";
    const queries = Array.isArray(config.queries) ? config.queries.filter((item): item is string => typeof item === "string") : [];
    if (url) return url;
    if (queries.length) return queries.join(" / ");
    return site || source.kind;
}

/** 旧版本存在 localStorage 里的 RSS 订阅，第一次加载时搬进 Rust，然后清空。 */
async function migrateLegacyRss(): Promise<void> {
    if (!useCustomFeeds.persist.hasHydrated()) return;
    const legacy = useCustomFeeds.getState().feeds;
    if (!legacy.length) return;
    for (const feed of legacy) {
        try {
            await invoke("feeds_save_source", { input: { kind: "rss", name: feed.name, config: { url: feed.url } } });
        } catch {
            // 单条坏数据不该挡住其余订阅的迁移
        }
    }
    useCustomFeeds.setState({ feeds: [] });
}
