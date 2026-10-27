/** 搜索状态：检索 + 可选的答案综合（没配 AI 时只出结果） */
import { create } from "zustand";
import { ask } from "@/search/pipeline";

interface SearchState {
  query: string;
  asking: boolean;
  answer: string;
  sources: { title: string; url: string; content: string }[];
  /** false = 没配 AI，只有检索结果，没有答案 */
  synthesized: boolean;
  error?: string;
  setQuery: (q: string) => void;
  run: () => Promise<void>;
}

export const useAiSearch = create<SearchState>((set, get) => ({
  query: "",
  asking: false,
  answer: "",
  sources: [],
  synthesized: true,
  error: undefined,

  setQuery: (q) => set({ query: q }),

  run: async () => {
    const q = get().query.trim();
    if (!q || get().asking) return;
    set({ asking: true, answer: "", sources: [], synthesized: true, error: undefined });
    try {
      const result = await ask(q, (delta) =>
        set((s) => ({ answer: s.answer + delta })),
      );
      set({ sources: result.sources, answer: result.answer, synthesized: result.synthesized });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ asking: false });
    }
  },
}));
