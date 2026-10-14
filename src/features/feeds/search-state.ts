/** AI 搜索状态：问答流式（资讯页局部） */
import { create } from "zustand";
import { ask } from "@/search/pipeline";

interface SearchState {
  query: string;
  asking: boolean;
  answer: string;
  sources: { title: string; url: string; content: string }[];
  error?: string;
  setQuery: (q: string) => void;
  run: () => Promise<void>;
}

export const useAiSearch = create<SearchState>((set, get) => ({
  query: "",
  asking: false,
  answer: "",
  sources: [],
  error: undefined,

  setQuery: (q) => set({ query: q }),

  run: async () => {
    const q = get().query.trim();
    if (!q || get().asking) return;
    set({ asking: true, answer: "", sources: [], error: undefined });
    try {
      const { sources } = await ask(q, (delta) =>
        set((s) => ({ answer: s.answer + delta })),
      );
      set({ sources });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ asking: false });
    }
  },
}));
