import { create } from "zustand";

export type Page = "prompts" | "mcp" | "skills" | "vault" | "env" | "settings";

interface UiState {
  page: Page;
  previous: Page | null;
  setPage: (p: Page) => void;
  /** 回到上一个主界面（用于设置页的返回按钮） */
  goBack: () => void;
}

const MAIN_PAGES: Page[] = ["prompts", "mcp", "skills", "vault", "env"];

export const useUi = create<UiState>((set, get) => ({
  page: "skills",
  previous: null,
  setPage: (page) => {
    const cur = get().page;
    if (cur === page) return;
    // 只有从主界面进入设置时才记录返回目标
    set({ page, previous: MAIN_PAGES.includes(cur) && page === "settings" ? cur : get().previous });
  },
  goBack: () => {
    const prev = get().previous ?? "skills";
    set({ page: prev, previous: null });
  },
}));
