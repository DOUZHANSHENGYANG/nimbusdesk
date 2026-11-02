import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";

export interface CustomFeed {
  id: string;
  name: string;
  group: string;
  url: string;
}

interface CustomFeedsState {
  feeds: CustomFeed[];
  add: (feed: CustomFeed) => void;
  update: (id: string, patch: Partial<Omit<CustomFeed, "id">>) => void;
  remove: (id: string) => void;
  /** 拖动排序：把这个源挪到第 index 位（越界时夹到两端）。 */
  move: (id: string, index: number) => void;
}

export const useCustomFeeds = create<CustomFeedsState>()(
  persist(
    (set) => ({
      feeds: [],
      add: (feed) => set((s) => ({ feeds: [...s.feeds.filter((f) => f.id !== feed.id), feed] })),
      update: (id, patch) => set((s) => ({ feeds: s.feeds.map((feed) => feed.id === id ? { ...feed, ...patch, id: feed.id } : feed) })),
      remove: (id) => set((s) => ({ feeds: s.feeds.filter((f) => f.id !== id) })),
      move: (id, index) => set((s) => {
        const from = s.feeds.findIndex((feed) => feed.id === id);
        if (from < 0) return s;
        const next = s.feeds.filter((feed) => feed.id !== id);
        next.splice(Math.max(0, Math.min(index, next.length)), 0, s.feeds[from]);
        return { feeds: next };
      }),
    }),
    { name: "custom-feeds", storage: createJSONStorage(() => tauriJsonStorage), version: 1 },
  ),
);
