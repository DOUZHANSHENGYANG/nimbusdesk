/**
 * 奇妙搜索源（EOS）作为 searchWeb 的后端之一。
 *
 * 为什么不按规则表顺序全跑：实测 215 条规则里只有 37 条能抽出 ≥2 条结果，
 * 且单条要 1–7 秒。全跑一遍十几秒起步，用户等不了。
 *
 * 所以按「健康度优先 + 时间预算 + 够用即停」调度：
 *  - rankRules 把上次有产出的排前面，冷却中的排除；
 *  - 并发跑，凑够 maxResults 就提前收工；
 *  - 每条结果都记进健康度表，失败的自动进冷却 —— 越用越快。
 */
import { httpText } from "@/sources/http";
import type { WebResult } from "../tavily";
import { extractHits, extractResources, type EosHit } from "./extract";
import { isCooling, rankRules, useEosHealth } from "./health";
import { SEARCHABLE_RULES, buildEosUrl, type EosRule } from "./rule";

export interface EosSearchOptions {
  maxResults?: number;
  /** 整体时间预算，到点就返回已有结果 */
  budgetMs?: number;
  /** 同时进行的请求数 */
  concurrency?: number;
  /** 单条规则超时 */
  perRuleMs?: number;
}

const DEFAULTS: Required<EosSearchOptions> = {
  maxResults: 8,
  budgetMs: 9000,
  concurrency: 6,
  perRuleMs: 7000,
};

export interface EosSearchResult {
  results: WebResult[];
  /** 本次实际尝试的规则数 / 总数，用于设置页展示"用了多少源" */
  attempted: number;
  available: number;
}

async function runRule(rule: EosRule, keyword: string, perRuleMs: number): Promise<EosHit[]> {
  const url = buildEosUrl(rule, keyword);
  const headers: Record<string, string> = {};
  if (rule.ua) headers["User-Agent"] = rule.ua;
  if (rule.referer) headers.Referer = rule.referer;

  const html = await httpText(url, { headers }, perRuleMs);
  const hits = extractHits(html, url, keyword, rule);

  // 页面里直接给出网盘/磁力时，把它当成一条高优先级结果 —— 这才是这批规则的真正价值
  for (const resource of extractResources(html, keyword)) {
    hits.unshift({
      title: resource.label || `${rule.title} · 网盘资源`,
      url: resource.url,
      ruleTitle: rule.title,
      group: rule.group,
      score: 99,
    });
  }
  return hits;
}

/** 结果去重：同一 URL 只留分数最高的一条 */
function dedupe(hits: EosHit[]): EosHit[] {
  const best = new Map<string, EosHit>();
  for (const hit of hits) {
    const key = hit.url.replace(/[#?].*$/, "");
    const prev = best.get(key);
    if (!prev || hit.score > prev.score) best.set(key, hit);
  }
  return [...best.values()];
}

/**
 * 按来源轮转取前 N 条。
 *
 * 不能简单按分数排：实测 Naver 一条规则就能产出 93 条，会把 8 个位置全占满，
 * 结果全是同一个站的内容。轮转保证「每个站最多贡献 PER_RULE 条」，
 * 名额没填满时再放宽到 MAX_PER_RULE —— 但绝不退化成"一个站刷满整屏"。
 */
const PER_RULE = 2;
const MAX_PER_RULE = 4;

function interleave(hits: EosHit[], limit: number): EosHit[] {
  const sorted = [...hits].sort((a, b) => b.score - a.score);

  const take = (perRule: number, out: EosHit[]) => {
    const counts = new Map<string, number>();
    for (const hit of out) counts.set(hit.ruleTitle, (counts.get(hit.ruleTitle) ?? 0) + 1);
    const taken = new Set(out.map((h) => h.url));
    for (const hit of sorted) {
      if (out.length >= limit) break;
      if (taken.has(hit.url)) continue;
      const used = counts.get(hit.ruleTitle) ?? 0;
      if (used >= perRule) continue;
      out.push(hit);
      taken.add(hit.url);
      counts.set(hit.ruleTitle, used + 1);
    }
  };

  const out: EosHit[] = [];
  take(PER_RULE, out);
  if (out.length < limit) take(MAX_PER_RULE, out);
  return out;
}

export async function searchEos(keyword: string, options: EosSearchOptions = {}): Promise<EosSearchResult> {
  const { maxResults, budgetMs, concurrency, perRuleMs } = { ...DEFAULTS, ...options };
  const query = keyword.trim();
  if (!query) return { results: [], attempted: 0, available: SEARCHABLE_RULES.length };

  const store = useEosHealth.getState();
  const ranked = rankRules(SEARCHABLE_RULES, store.rules);
  const deadline = Date.now() + budgetMs;

  const collected: EosHit[] = [];
  let cursor = 0;
  let attempted = 0;
  let stopped = false;

  /** 够用即停：要求结果数量达标，且来自至少 3 个不同的站 */
  const enough = () => {
    if (collected.length < maxResults) return false;
    return new Set(collected.map((h) => h.ruleTitle)).size >= 3;
  };

  async function worker(): Promise<void> {
    while (!stopped) {
      if (Date.now() > deadline || enough()) { stopped = true; return; }
      const index = cursor++;
      if (index >= ranked.length) return;
      const rule = ranked[index];
      attempted++;
      try {
        const hits = await runRule(rule, query, perRuleMs);
        // 页面能打开但抽不到结果，等价于「这条规则已经没用了」：照样记失败，
        // 否则改版成 JS 渲染的站点会一直占着前面的位置。
        if (hits.length) {
          useEosHealth.getState().recordOk(rule.id, hits.length);
          collected.push(...hits);
        } else {
          useEosHealth.getState().recordFail(rule.id);
        }
      } catch {
        useEosHealth.getState().recordFail(rule.id);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, ranked.length) }, worker));

  const results = interleave(dedupe(collected), maxResults).map((hit) => ({
    title: hit.title,
    url: hit.url,
    content: `${hit.ruleTitle}（${hit.group}）`,
  }));

  return { results, attempted, available: ranked.length };
}

/** 设置页用：当前有多少条规则可用 / 在冷却中 */
export function eosHealthSummary(now = Date.now()) {
  const { rules } = useEosHealth.getState();
  const cooling = SEARCHABLE_RULES.filter((rule) => isCooling(rules[rule.id], now)).length;
  return { total: SEARCHABLE_RULES.length, cooling, usable: SEARCHABLE_RULES.length - cooling };
}
