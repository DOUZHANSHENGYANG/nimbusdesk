/** GitHub 面板的 IO：token 走 Rust（系统凭据管理器 / 环境变量），其余请求走统一网络层。 */
import { invoke } from "@tauri-apps/api/core";
import { httpJson, httpText, rawFetch } from "@/sources/http";
import { chatWithProvider } from "@/features/ai/client";
import {
  aiTranslatePrompt, API, edgeTranslateUrl, normalizeRepo, parseEdgeTranslation,
  parseTrendingHtml, reposPath, starUrl, translateWithFallback, trendingFallbackUrl, trendingPageUrl, MAX_PAGES, PAGE_SIZE,
} from "./github-core";
import type { DownloadResult, GithubRepo, GithubTokenSource, GithubViewer, TranslationResult, TrendingRepo } from "./github-types";

export function tokenStatus(): Promise<{ source: GithubTokenSource }> {
  return invoke("github_token_status");
}

export function saveToken(token: string): Promise<void> {
  return invoke("github_save_token", { token });
}

export function forgetToken(): Promise<void> {
  return invoke("github_forget_token");
}

/** 401 时给用户看的提示：token 失效比网络错误更需要重配。 */
export function describeGithubError(error: unknown, copy: { authFailed: string; rate: string; failed: string }): string {
  const message = String(error instanceof Error ? error.message : error);
  if (/HTTP 401|HTTP 403.*auth|GITHUB_TOKEN_MISSING/i.test(message)) return copy.authFailed;
  if (/HTTP 403|HTTP 429/i.test(message)) return copy.rate;
  return copy.failed;
}

async function request<T>(token: string, path: string): Promise<T> {
  const result = await httpJson<T>(path, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  return result;
}

export async function fetchViewer(token: string): Promise<GithubViewer> {
  const raw = await request<{ login?: string; name?: string; avatar_url?: string }>(token, `${API}/user`);
  return { login: raw.login ?? "", name: raw.name ?? "", avatarUrl: raw.avatar_url ?? "" };
}

export interface RepoPageResult {
  repos: GithubRepo[];
  /** 最后一页仍是满页：说明还有下一页没取，这份清单不是全集，不能拿它判断「消失」。 */
  truncated: boolean;
}

export async function fetchRepos(token: string, kind: "mine" | "starred"): Promise<RepoPageResult> {
  // 一页 100 条；仓库多的时候翻到不满页为止，最多 MAX_PAGES 页（500 条）。
  const repos: GithubRepo[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const raw = await request<Record<string, unknown>[]>(token, reposPath(kind, page));
    repos.push(...raw.map(normalizeRepo));
    if (raw.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) truncated = true;
  }
  return { repos, truncated };
}

export async function setStar(token: string, fullName: string, on: boolean): Promise<void> {
  const response = await rawFetch(starUrl(fullName), {
    method: on ? "PUT" : "DELETE",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Length": "0" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

/** 下载走 Rust（codeload zip）：落盘、改名、写临时文件都在那边做，前端只给目标目录。 */
export function defaultDownloadDir(): Promise<string> {
  return invoke("github_default_download_dir");
}

export function downloadRepoZip(repo: Pick<GithubRepo, "owner" | "name" | "defaultBranch">, dir?: string): Promise<DownloadResult> {
  return invoke("github_download_zip", { owner: repo.owner, repo: repo.name, branch: repo.defaultBranch || "main", dir });
}

/** 热榜：先解析 trending 页面；页面结构变化时退到 Search API（口径是「近期新项目」，UI 要标明）。 */
export async function fetchTrending(): Promise<{ items: TrendingRepo[]; fallback: boolean }> {
  try {
    const items = parseTrendingHtml(await httpText(trendingPageUrl(), undefined, 15000));
    if (items.length) return { items, fallback: false };
  } catch {
    // 落到下面的兜底
  }
  const raw = await httpJson<{ items?: Record<string, unknown>[] }>(trendingFallbackUrl());
  const items = (raw.items ?? []).map((repo) => {
    const normalized = normalizeRepo(repo);
    return {
      fullName: normalized.fullName, owner: normalized.owner, name: normalized.name, url: normalized.htmlUrl,
      description: normalized.description, language: normalized.language, stars: normalized.stars, gained: 0,
    };
  });
  return { items, fallback: true };
}

/**
 * README 走仓库接口而不是 raw 地址：带 token 能读私有仓库，也不受文件名大小写
 * （readme.md / README.rst）影响；只有 404 才是真的没有 README。
 */
export async function fetchReadme(token: string, repo: GithubRepo): Promise<string> {
  try {
    return await httpText(`${API}/repos/${repo.owner}/${repo.name}/readme`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw" },
    }, 15000);
  } catch (error) {
    if (/HTTP 404/.test(String(error))) return "";
    throw error;
  }
}

/**
 * 划词翻译：先走免费的 Edge 端点（无鉴权、支持批量、国内可达），
 * 失败再交给本机已配置的 AI —— 没有配置 AI 时把原始错误抛给调用方。
 */
export function translateSelection(text: string, target: string): Promise<TranslationResult> {
  return translateWithFallback<TranslationResult>(
    async () => {
      const response = await httpJson<unknown>(edgeTranslateUrl(target), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([text]),
      });
      return { text: parseEdgeTranslation(response)[0] ?? "", engine: "edge" as const };
    },
    async () => {
      const translated = await chatWithProvider(aiTranslatePrompt(text, target));
      return { text: translated.trim(), engine: "ai" as const };
    },
  );
}
