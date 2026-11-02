/** GitHub 面板的纯逻辑：解析、URL 构造、翻译请求的收发。不碰网络和 React。 */
import type { GithubCache, GithubLink, GithubPin, GithubRepo, TrendingRepo } from "./github-types";

export const API = "https://api.github.com";

/** token 从输入框进来时要挡掉的空白和换行；形状校验在 Rust 侧。 */
export function cleanToken(raw: string): string {
  return raw.replace(/\s+/g, "");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function normalizeRepo(raw: Record<string, unknown>): GithubRepo {
  const owner = (raw.owner as { login?: unknown } | undefined)?.login;
  const ownerLogin = text(owner) || text(raw.full_name).split("/")[0] || "";
  const name = text(raw.name);
  return {
    id: count(raw.id),
    owner: ownerLogin,
    name,
    fullName: text(raw.full_name) || `${ownerLogin}/${name}`,
    description: text(raw.description),
    language: typeof raw.language === "string" ? raw.language : null,
    stars: count(raw.stargazers_count),
    forks: count(raw.forks_count),
    // fork 标记由 API 直接给出，不需要再请求 parent。
    fork: raw.fork === true,
    parentFullName: typeof (raw.parent as { full_name?: unknown } | undefined)?.full_name === "string"
      ? String((raw.parent as { full_name: string }).full_name)
      : null,
    archived: raw.archived === true,
    defaultBranch: text(raw.default_branch) || "main",
    updatedAt: text(raw.pushed_at) || text(raw.updated_at),
    htmlUrl: text(raw.html_url) || `https://github.com/${ownerLogin}/${name}`,
    topics: Array.isArray(raw.topics) ? raw.topics.filter((topic): topic is string => typeof topic === "string") : [],
  };
}

/** 一页 100 条；列表翻到不满页就停，最多 5 页（500 条），再多就该用搜索而不是滚动。 */
export const MAX_PAGES = 5;
export const PAGE_SIZE = 100;

export function reposPath(kind: "mine" | "starred", page = 1): string {
  // 一页 100 条；超过一页的仓库不在 P1 范围内，靠搜索框收敛。
  const base = kind === "mine" ? "/user/repos" : "/user/starred";
  const params = kind === "mine" ? "sort=updated&affiliation=owner,collaborator" : "sort=updated";
  return `${API}${base}?per_page=100&page=${page}&${params}`;
}

export function starUrl(fullName: string): string {
  return `${API}/user/starred/${fullName.split("/").map(encodeURIComponent).join("/")}`;
}

/** 热榜没有官方 API，只能解析 trending 页面；失败时退到「最近创建且 star 最多」。 */
export function trendingPageUrl(since: "daily" | "weekly" | "monthly" = "daily"): string {
  return `https://github.com/trending?since=${since}`;
}

export function trendingFallbackUrl(days = 7, today = new Date()): string {
  const since = new Date(today.getTime() - days * 86400_000).toISOString().slice(0, 10);
  return `${API}/search/repositories?q=created:>${since}&sort=stars&order=desc&per_page=25`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " " };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, code: string) => {
    if (/^#x/i.test(code)) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (/^#/.test(code)) return String.fromCodePoint(parseInt(code.slice(1), 10));
    return ENTITIES[code] ?? whole;
  });
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function number(value: string | undefined): number {
  return Number((value ?? "").replace(/[^\d]/g, "")) || 0;
}

/**
 * 解析 github.com/trending 的 HTML。页面是服务端渲染的 article.Box-row，
 * 没有 API 可用；选择器或结构变了就返回空数组，由调用方退到 Search API。
 */
export function parseTrendingHtml(html: string): TrendingRepo[] {
  const blocks = html.match(/<article[^>]*class="[^"]*Box-row[^"]*"[\s\S]*?<\/article>/g) ?? [];
  const repos: TrendingRepo[] = [];
  for (const block of blocks) {
    const href = block.match(/<h2[\s\S]*?<a[^>]*href="\/([^"\s]+)"/)?.[1] ?? "";
    const [owner, name] = href.split("/");
    if (!owner || !name) continue;
    const aside = block.match(/<\/svg>\s*([\d,]+)\s+stars?\s+(?:today|this week|this month)/)?.[1] ?? "";
    repos.push({
      fullName: `${owner}/${name}`,
      owner,
      name,
      url: `https://github.com/${owner}/${name}`,
      description: stripTags(block.match(/<p class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? ""),
      language: stripTags(block.match(/itemprop="programmingLanguage"[^>]*>([^<]+)</)?.[1] ?? "") || null,
      // 总数在 stargazers 链接里，图标之后才是数字；直接取内层 HTML 会把 svg 路径里的数字也算进去。
      stars: number(block.match(/href="\/[^"]+\/stargazers"[\s\S]*?<\/svg>\s*([\d,]+)\s*<\/a>/)?.[1]),
      gained: number(aside),
    });
  }
  return repos;
}

/** Edge 内部翻译端点：无需鉴权，body 为字符串数组，from 留空表示自动检测。 */
export function edgeTranslateUrl(to: string, from = ""): string {
  return `https://edge.microsoft.com/translate/translatetext?from=${from}&to=${to}&isEnterpriseClient=false`;
}

export function parseEdgeTranslation(json: unknown): string[] {
  if (!Array.isArray(json)) throw new Error("Unexpected translation response");
  return json.map((item) => {
    const translated = (item as { translations?: { text?: unknown }[] } | null)?.translations?.[0]?.text;
    if (typeof translated !== "string") throw new Error("Unexpected translation response");
    return translated;
  });
}

/** 划词翻译只翻一段，标题式的短文本走同一入口。 */
export function aiTranslatePrompt(text: string, to: string): { role: "system" | "user"; content: string }[] {
  return [
    { role: "system", content: `Translate the user's text into the language tagged ${to}. Reply with the translation only.` },
    { role: "user", content: text },
  ];
}

/** 刷新时上一轮见过、这一轮没有的仓库：上游删掉、改名或失去权限都表现为「消失」。 */
export function detectGone(known: readonly GithubRepo[], fresh: readonly GithubRepo[]): GithubRepo[] {
  const alive = new Set(fresh.map(repo => repo.fullName));
  return known.filter(repo => !alive.has(repo.fullName));
}

/** fork 的 parent 字段没了 = 上游仓库已删除：GitHub 保留 fork，但不再给出 parent。 */
export function upstreamGone(repo: Pick<GithubRepo, "fork" | "parentFullName">): boolean {
  return repo.fork && !repo.parentFullName;
}

/** 主通道失败就走兜底；兜底也失败时抛主通道的错（用户看到的应是「翻译失败」而不是兜底细节）。 */
export async function translateWithFallback<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  try {
    return await primary();
  } catch (primaryError) {
    try {
      return await fallback();
    } catch {
      throw primaryError;
    }
  }
}

/** 热榜条目没有 API 的完整字段，读 README 前补成仓库形状。 */
export function repoFromTrending(item: TrendingRepo): GithubRepo {
  return {
    id: 0, owner: item.owner, name: item.name, fullName: item.fullName, description: item.description,
    language: item.language, stars: item.stars, forks: 0, fork: false, parentFullName: null, archived: false,
    defaultBranch: "main", updatedAt: "", htmlUrl: item.url, topics: [],
  };
}

export function repoMatches(repo: { fullName: string; description: string; language: string | null; topics: string[] }, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [repo.fullName, repo.description, repo.language ?? "", ...repo.topics].some(value => value.toLocaleLowerCase().includes(needle));
}

/** `owner/name` 的严格形状：这段字符串会变成 starr/下载/关联的键，不接受别的写法。 */
export function validRepoFullName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  if (parts.length !== 2) return false;
  return parts.every(part => part.length > 0 && part.length <= 100 && part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/.test(part));
}

/** 置顶只是排序，不改远端：置顶的排前面，其余保持原顺序。 */
export function sortPinned<T extends { fullName: string }>(rows: readonly T[], pinned: ReadonlySet<string>): T[] {
  return [...rows.filter(row => pinned.has(row.fullName)), ...rows.filter(row => !pinned.has(row.fullName))];
}

export interface GithubLocalData {
  pins: GithubPin[];
  links: GithubLink[];
  downloadDir: string | null;
  /** 基线属于哪个账号；换 token 换账号时不能拿旧账号的清单做差集 */
  login: string | null;
  /** 上次成功的快照，先渲染它再后台对齐 */
  cache: GithubCache;
  /** 上一轮成功拉到的「我的仓库」，用来发现这一轮消失的条目 */
  knownRepos: GithubRepo[];
  /** 已经消失的仓库：保留快照，界面上标成「已不存在」而不是直接删掉 */
  missing: GithubMissing[];
}

export interface GithubMissing {
  repo: GithubRepo;
  since: number;
}

export const emptyGithubCache = (): GithubCache => ({ viewer: null, starred: [], trending: [], trendingFallback: false, at: 0, readmes: {} });

export const emptyGithubLocalData = (): GithubLocalData => ({ pins: [], links: [], downloadDir: null, login: null, cache: emptyGithubCache(), knownRepos: [], missing: [] });

/** README 缓存上限：条数与单条体积都封顶，免得本机状态被大文件撑爆。 */
export const README_CACHE_ENTRIES = 24;
export const README_CACHE_BYTES = 120_000;

/** 写一条 README 缓存并按 LRU 截断；返回新的表（不修改入参）。 */
export function cacheReadme(readmes: GithubCache["readmes"], fullName: string, markdown: string, now: number): GithubCache["readmes"] {
  if (!validRepoFullName(fullName) || !markdown.trim() || markdown.length > README_CACHE_BYTES) return readmes;
  const next = { ...readmes, [fullName]: { markdown, at: now } };
  const ordered = Object.entries(next).sort((a, b) => b[1].at - a[1].at).slice(0, README_CACHE_ENTRIES);
  return Object.fromEntries(ordered);
}

/**
 * 一次成功同步后的本机状态。
 *
 * 三条不变量：只在成功拉取后调用；账号变了就重置基线而不是做差集；
 * 回来的仓库清掉标记，新消失的用本轮快照留底。
 */
export function applySync(data: GithubLocalData, login: string, fresh: readonly GithubRepo[], now: number): GithubLocalData {
  const sameAccount = Boolean(login) && data.login === login;
  const gone = sameAccount ? detectGone(data.knownRepos, fresh) : [];
  const alive = new Set(fresh.map(repo => repo.fullName));
  const previous = sameAccount ? data.missing : [];
  const kept = previous.filter(entry => !alive.has(entry.repo.fullName) && !gone.some(repo => repo.fullName === entry.repo.fullName));
  const added = gone.filter(repo => !previous.some(entry => entry.repo.fullName === repo.fullName));
  return { ...data, login, knownRepos: [...fresh], missing: [...kept, ...added.map(repo => ({ repo, since: now }))] };
}

function validateGithubCache(cache: GithubCache | undefined): void {
  if (!cache || !Array.isArray(cache.starred) || !Array.isArray(cache.trending) || typeof cache.readmes !== "object" || cache.readmes === null) throw new Error("Invalid GitHub cache");
  if (!Number.isSafeInteger(cache.at) || cache.at < 0) throw new Error("Invalid GitHub cache");
  if (typeof cache.trendingFallback !== "boolean") throw new Error("Invalid GitHub cache");
  if (cache.viewer !== null && (typeof cache.viewer.login !== "string" || !cache.viewer.login.trim())) throw new Error("Invalid GitHub cache");
  for (const repo of cache.starred) if (!validRepoFullName(repo?.fullName)) throw new Error("Invalid GitHub cache");
  const entries = Object.entries(cache.readmes);
  if (entries.length > README_CACHE_ENTRIES) throw new Error("Invalid GitHub readme cache");
  for (const [fullName, entry] of entries) {
    if (!validRepoFullName(fullName) || typeof entry?.markdown !== "string" || entry.markdown.length > README_CACHE_BYTES || !Number.isSafeInteger(entry.at)) throw new Error("Invalid GitHub readme cache");
  }
}

export function validateGithubData(data: GithubLocalData): void {
  if (!data || !Array.isArray(data.pins) || !Array.isArray(data.links)) throw new Error("Invalid GitHub data");
  if (!Array.isArray(data.knownRepos) || !Array.isArray(data.missing)) throw new Error("Invalid GitHub data");
  if (data.downloadDir !== null && (typeof data.downloadDir !== "string" || !data.downloadDir.trim())) throw new Error("Invalid GitHub download folder");
  if (data.login !== null && (typeof data.login !== "string" || !data.login.trim())) throw new Error("Invalid GitHub account");
  validateGithubCache(data.cache);
  const known = new Set<string>();
  for (const repo of data.knownRepos) {
    if (!validRepoFullName(repo?.fullName) || known.has(repo.fullName)) throw new Error("Invalid GitHub repo snapshot");
    known.add(repo.fullName);
  }
  const missing = new Set<string>();
  for (const entry of data.missing) {
    if (!validRepoFullName(entry?.repo?.fullName) || missing.has(entry.repo.fullName) || !Number.isSafeInteger(entry.since) || entry.since < 0) throw new Error("Invalid GitHub missing repo");
    missing.add(entry.repo.fullName);
  }
  const pins = new Set<string>();
  for (const pin of data.pins) {
    if (!validRepoFullName(pin.fullName) || pins.has(pin.fullName) || !Number.isSafeInteger(pin.pinnedAt) || pin.pinnedAt < 0) throw new Error("Invalid GitHub pin");
    pins.add(pin.fullName);
  }
  const links = new Set<string>();
  // 一个仓库可以挂多个本地项目；只要求同一对「项目 × 仓库」不重复。
  for (const link of data.links) {
    if (!validRepoFullName(link.fullName) || typeof link.projectId !== "string" || !link.projectId.trim() || !Number.isSafeInteger(link.linkedAt) || link.linkedAt < 0) throw new Error("Invalid GitHub link");
    const pair = `${link.projectId}|${link.fullName}`;
    if (links.has(pair)) throw new Error("Invalid GitHub link");
    links.add(pair);
  }
}
