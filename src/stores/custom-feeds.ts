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
  remove: (id: string) => void;
}

export const useCustomFeeds = create<CustomFeedsState>()(
  persist(
    (set) => ({
      feeds: [],
      add: (feed) => set((s) => ({ feeds: [...s.feeds.filter((f) => f.id !== feed.id), feed] })),
      remove: (id) => set((s) => ({ feeds: s.feeds.filter((f) => f.id !== id) })),
    }),
    { name: "custom-feeds", storage: createJSONStorage(() => tauriJsonStorage), version: 1 },
  ),
);
