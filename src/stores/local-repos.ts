import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriJsonStorage } from "@/lib/storage";

/**
 * 本机 git 仓库登记表。
 *
 * 和项目、和 GitHub 都解耦：GitHub 面板管的是**远程**仓库，这里管**本机目录**里
 * 那些不推到任何远程的（私人实验、内网代码、还没建 remote 的）。只登记路径，
 * 不搬代码、不改仓库 —— 状态由 `git_repo_status` 现读。
 */
interface LocalReposState {
  repos: string[];
  add: (path: string) => void;
  remove: (path: string) => void;
}

/** 上限 20：这是给人看的一列，不是索引服务 */
const MAX = 20;

export const useLocalRepos = create<LocalReposState>()(
  persist(
    (set, get) => ({
      repos: [],
      add: (path) => {
        const value = path.trim();
        if (!value || get().repos.includes(value) || get().repos.length >= MAX) return;
        set({ repos: [...get().repos, value] });
      },
      remove: (path) => set({ repos: get().repos.filter((item) => item !== path) }),
    }),
    { name: "local-repos", storage: createJSONStorage(() => tauriJsonStorage) },
  ),
);
