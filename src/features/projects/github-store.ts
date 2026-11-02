/**
 * GitHub 面板的本机状态：置顶、与本地项目的关联、下载目录。
 *
 * GitHub 没有「写 pinned」的 API（GraphQL mutation 里只有 pinIssue / pinEnvironment），
 * 所以置顶是本软件自己的排序；与本地项目的关联也只存这里，不进 ProjectData——
 * 删项目时不会连带破坏仓库数据。
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { onStorageSynced, tauriJsonStorage } from "@/lib/storage";
import { useStorageHealth } from "@/stores/storage-health";
import { applySync, cacheReadme as trimReadmes, emptyGithubLocalData, validateGithubData, type GithubLocalData } from "./github-core";
import type { GithubCache, GithubRepo } from "./github-types";

interface Store extends GithubLocalData {
  togglePin(fullName: string): void;
  link(projectId: string, fullName: string): void;
  unlink(projectId: string, fullName: string): void;
  unlinkRepo(fullName: string): void;
  setDownloadDir(dir: string | null): void;
  /** 每次成功拉完「我的仓库」后调用：消失的进 missing，回来的从 missing 里摘掉。 */
  recordSync(login: string, fresh: GithubRepo[]): void;
  /** 一次成功刷新后写入快照：下次进来先渲染它，再后台对齐。 */
  saveCache(patch: Partial<Pick<GithubCache, "viewer" | "starred" | "trending" | "trendingFallback">>, now?: number): void;
  cacheReadme(fullName: string, markdown: string): void;
  dismissMissing(fullName: string): void;
}

export function githubLocalData(s: GithubLocalData): GithubLocalData {
  return { pins: s.pins, links: s.links, downloadDir: s.downloadDir, login: s.login, cache: s.cache, knownRepos: s.knownRepos, missing: s.missing };
}

export const useGithub = create<Store>()(persist<Store, [], [], GithubLocalData>((set) => {
  function change(fn: (data: GithubLocalData) => GithubLocalData) {
    if (!useGithub.persist.hasHydrated()) throw new Error("GitHub settings are still loading");
    set(s => { const next = fn(githubLocalData(s)); validateGithubData(next); return next; });
  }
  return {
    ...emptyGithubLocalData(),
    togglePin(fullName) {
      const now = Date.now();
      change(data => data.pins.some(pin => pin.fullName === fullName)
        ? { ...data, pins: data.pins.filter(pin => pin.fullName !== fullName) }
        : { ...data, pins: [...data.pins, { fullName, pinnedAt: now }] });
    },
    link(projectId, fullName) {
      const now = Date.now();
      // 一个仓库可挂多个项目：只摘掉同一对「项目 × 仓库」，不碰其他关联。
      change(data => ({ ...data, links: [...data.links.filter(item => !(item.projectId === projectId && item.fullName === fullName)), { projectId, fullName, linkedAt: now }] }));
    },
    unlink(projectId, fullName) {
      change(data => ({ ...data, links: data.links.filter(item => !(item.projectId === projectId && item.fullName === fullName)) }));
    },
    unlinkRepo(fullName) {
      change(data => ({ ...data, links: data.links.filter(item => item.fullName !== fullName) }));
    },
    setDownloadDir(dir) {
      change(data => ({ ...data, downloadDir: dir?.trim() ? dir.trim() : null }));
    },
    recordSync(login, fresh) {
      const now = Date.now();
      // 合并规则在 applySync 里，纯函数、有单测；这里只负责落地。
      change(data => applySync(data, login, fresh, now));
    },
    saveCache(patch, now = Date.now()) {
      change(data => ({ ...data, cache: { ...data.cache, ...patch, at: now } }));
    },
    cacheReadme(fullName, markdown) {
      const now = Date.now();
      change(data => ({ ...data, cache: { ...data.cache, readmes: trimReadmes(data.cache.readmes, fullName, markdown, now) } }));
    },
    dismissMissing(fullName) {
      change(data => ({ ...data, missing: data.missing.filter(entry => entry.repo.fullName !== fullName), knownRepos: data.knownRepos.filter(repo => repo.fullName !== fullName) }));
    },
  };
}, {
  name: "github", version: 4, storage: createJSONStorage(() => tauriJsonStorage), partialize: githubLocalData,
  // v1 没有 knownRepos / missing：补齐空表，老数据照常升级。
  migrate: (saved) => ({ ...emptyGithubLocalData(), ...(saved as Partial<GithubLocalData>) }),
  merge: (saved, current) => { if (!saved) return current; validateGithubData(saved as GithubLocalData); return { ...current, ...(saved as GithubLocalData) }; },
  onRehydrateStorage: () => (_s, error) => { if (error) useStorageHealth.getState().report("unavailable", "github", "Unable to load GitHub settings"); },
}));

onStorageSynced((key, value) => {
  if (key !== "github" || !value || typeof value !== "object") return;
  try {
    const data = { ...emptyGithubLocalData(), ...(value as { state: GithubLocalData }).state };
    validateGithubData(data);
    useGithub.setState(data);
  } catch {
    useStorageHealth.getState().report("unavailable", "github", "Unable to load GitHub settings");
  }
});
