/** 资讯页状态：源合并、抓取调度、收藏伪源 */
import { create } from "zustand";
import { mergedSources } from "@/sources/custom";
import type { SourceAdapter, SourceEntry } from "@/sources/types";

export const FAVORITES_ID = "__favorites__";

interface FeedsState {
  activeId: string;
  entriesBySource: Record<string, SourceEntry[]>;
  loading: Record<string, boolean | undefined>;
  error: Record<string, string | undefined>;
  selected: SourceEntry | null;
  selectSource: (id: string) => void;
  refresh: (id?: string) => Promise<void>;
  selectEntry: (entry: SourceEntry | null) => void;
}

function resolve(id: string): SourceAdapter | null {
  return mergedSources().find((s) => s.id === id) ?? null;
}

export const useFeeds = create<FeedsState>((set, get) => ({
  activeId: "github-trending",
  entriesBySource: {},
  loading: {},
  error: {},
  selected: null,

  selectSource: (id) => {
    set({ activeId: id, selected: null });
    if (id !== FAVORITES_ID && !get().entriesBySource[id]) void get().refresh(id);
  },

  refresh: async (id) => {
    const sourceId = id ?? get().activeId;
    if (sourceId === FAVORITES_ID) return;
    const adapter = resolve(sourceId);
    if (!adapter) return;
    set((s) => ({ loading: { ...s.loading, [sourceId]: true }, error: { ...s.error, [sourceId]: undefined } }));
    try {
      const entries = await adapter.fetch();
      set((s) => ({ entriesBySource: { ...s.entriesBySource, [sourceId]: entries } }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set((s) => ({ error: { ...s.error, [sourceId]: msg } }));
    } finally {
      set((s) => ({ loading: { ...s.loading, [sourceId]: false } }));
    }
  },

  selectEntry: (entry) => set({ selected: entry }),
}));


