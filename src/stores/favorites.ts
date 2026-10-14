import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";
import type { SourceEntry } from "@/sources/types";

export interface FavEntry extends SourceEntry {
  sourceName?: string;
  savedAt: number;
}

interface FavState {
  items: FavEntry[];
  has: (url: string) => boolean;
  toggle: (entry: SourceEntry, sourceName?: string) => void;
  remove: (url: string) => void;
}

export const useFavorites = create<FavState>()(
  persist(
    (set, get) => ({
      items: [],
      has: (url) => get().items.some((i) => i.url === url),
      toggle: (entry, sourceName) => {
        const items = get().items;
        if (items.some((i) => i.url === entry.url)) {
          set({ items: items.filter((i) => i.url !== entry.url) });
        } else {
          const prev = items.find((i) => i.url === entry.url)?.sourceName;
          set({
            items: [
              {
                id: entry.url,
                title: entry.title,
                url: entry.url,
                extra: entry.extra,
                pubDate: entry.pubDate,
                sourceName: sourceName ?? prev,
                savedAt: Date.now(),
              },
              ...items,
            ],
          });
        }
      },
      remove: (url) => set((s) => ({ items: s.items.filter((i) => i.url !== url) })),
    }),
    { name: "favorites", storage: createJSONStorage(() => tauriJsonStorage), version: 1 },
  ),
);
