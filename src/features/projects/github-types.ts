/** GitHub 面板的数据形状：只留界面要用的字段，API 原始结构在 github-core 里收窄。 */

export type GithubTokenSource = "vault" | "env" | "none";

export interface GithubViewer {
  login: string;
  name: string;
  avatarUrl: string;
}

export interface GithubRepo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  language: string | null;
  stars: number;
  forks: number;
  /** 是 fork 的话，parent 给出上游仓库全名 */
  fork: boolean;
  parentFullName: string | null;
  archived: boolean;
  defaultBranch: string;
  updatedAt: string;
  htmlUrl: string;
  topics: string[];
}

export interface TrendingRepo {
  fullName: string;
  owner: string;
  name: string;
  url: string;
  description: string;
  language: string | null;
  stars: number;
  /** 榜单窗口内新增的 star，正则没抓到时为 0 */
  gained: number;
}

export interface TranslationResult {
  text: string;
  engine: "edge" | "ai";
}

/** 本软件自己的置顶与本地项目关联：GitHub 没有写 pinned 的 API，这些都存本机。 */
export interface GithubPin {
  fullName: string;
  pinnedAt: number;
}

export interface GithubLink {
  projectId: string;
  fullName: string;
  linkedAt: number;
}

export interface DownloadResult {
  path: string;
  bytes: number;
}

/** 上次成功拉到的最近一次结果；用来先出画面、再后台对齐（stale-while-revalidate）。 */
export interface GithubCache {
  viewer: GithubViewer | null;
  starred: GithubRepo[];
  trending: TrendingRepo[];
  trendingFallback: boolean;
  /** 最后一次成功同步的时间 */
  at: number;
  /** README 原文缓存：按 owner/name 存，只留最近打开的若干条 */
  readmes: Record<string, { markdown: string; at: number }>;
}
