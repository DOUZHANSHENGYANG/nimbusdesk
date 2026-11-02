/**
 * 信息调研流水线：规划 → 各渠道检索 → 抓正文 → 抽断言 → 合成简报 → 存档。
 *
 * 每个阶段之间检查取消与暂停：取消立刻停；暂停等在这个点上，继续后接着往下走。
 * 抓取与模型调用本身不发中断信号，让它们自然结束。
 */
import { invoke } from "@tauri-apps/api/core";
import { chatWithProvider } from "@/features/ai/client";
import { i18n } from "@/lib/i18n";
import { useSettings } from "@/stores/settings";

/** 事件里的 message 是给人看的一行字；数据本身仍留在字段里，界面可自行排版。 */
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);

export type Depth = "quick" | "standard" | "deep";
export type Channel = "web" | "cn-social" | "global" | "repo";

export const DEPTHS: Record<Depth, { subQuestions: number; perQuery: number; sources: number; claimsPerSource: number }> = {
    quick: { subQuestions: 3, perQuery: 4, sources: 6, claimsPerSource: 3 },
    standard: { subQuestions: 4, perQuery: 5, sources: 10, claimsPerSource: 4 },
    deep: { subQuestions: 6, perQuery: 6, sources: 16, claimsPerSource: 5 },
};

export const CHANNELS: Channel[] = ["web", "cn-social", "global", "repo"];

export interface Hit {
    title: string;
    url: string;
    channel: string;
    summary: string;
    author: string;
    publishedAt?: string | null;
}

export interface SourceDoc {
    index: number;
    title: string;
    url: string;
    channel: string;
    text: string;
    chars: number;
    ok: boolean;
    error?: string;
}

export interface Claim {
    claim: string;
    quote: string;
    source: number;
    verified: boolean;
}

export interface Plan {
    sub_questions: string[];
    web_queries: string[];
    social_queries: string[];
    repo_query: string;
}

/** 一次运行里发生的事；界面按 kind 回放成「阶段 + 过程」。 */
export type ResearchEvent =
    | { kind: "plan"; message: string; plan: Plan }
    | { kind: "search"; channel: Channel; status: "running" | "done" | "error"; count: number; items: Hit[]; message: string }
    | { kind: "fetch"; total: number; sources: Omit<SourceDoc, "text">[]; message: string }
    | { kind: "extract"; source: number; title: string; count: number; message: string }
    | { kind: "extract-total"; total: number; message: string }
    | { kind: "synthesize"; message: string }
    | { kind: "done"; message: string }
    | { kind: "error"; message: string }
    | { kind: "save"; file: string; message: string };

export interface ResearchResult {
    markdown: string;
    file: string;
    claims: Claim[];
    sources: SourceDoc[];
    warnings: string[];
}

/** 只取 JSON：模型常把答案套在 ```json 里，或前后加一句话。 */
export function parseJson<T>(text: string): T | null {
    const start = text.search(/[[{]/);
    if (start < 0) return null;
    const body = text.slice(start);
    const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
    if (end < 0) return null;
    try {
        return JSON.parse(body.slice(0, end + 1)) as T;
    } catch {
        return null;
    }
}

const clip = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit)}…`;
const clean = (values: unknown, limit: number): string[] =>
    Array.isArray(values)
        ? values.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean).slice(0, limit)
        : [];

async function plan(topic: string, depth: Depth, channels: Channel[]): Promise<Plan> {
    const config = DEPTHS[depth];
    const answer = await chatWithProvider([{
        role: "user",
        content: `你是调研规划助手。主题：${topic}
请拆出最多 ${config.subQuestions} 个能独立检索的子问题，并给出检索词。
只检索这些渠道：${channels.join("、")}（web=通用搜索；cn-social=中文社区；global=英文社区；repo=GitHub）。
只输出 JSON，不要解释：{"sub_questions":["…"],"web_queries":["…"],"social_queries":["…"],"repo_query":"…"}`,
    }]);
    const parsed = parseJson<Partial<Plan>>(answer);
    const subQuestions = clean(parsed?.sub_questions, config.subQuestions);
    return {
        sub_questions: subQuestions.length ? subQuestions : [topic],
        web_queries: clean(parsed?.web_queries, config.subQuestions + 2),
        social_queries: clean(parsed?.social_queries, config.subQuestions),
        repo_query: typeof parsed?.repo_query === "string" ? parsed.repo_query.trim() : "",
    };
}

export function queriesFor(channel: Channel, plan: Plan, topic: string): string[] {
    const fallback = plan.sub_questions.length ? plan.sub_questions : [topic];
    if (channel === "repo") return [plan.repo_query || topic];
    if (channel === "web") return plan.web_queries.length ? plan.web_queries : fallback;
    return plan.social_queries.length ? plan.social_queries : fallback;
}

/** 各渠道轮转着取，避免一个渠道把名额吃满。 */
export function pickSources(hits: Hit[], limit: number): Hit[] {
    const seen = new Set<string>();
    const buckets = new Map<string, Hit[]>();
    for (const hit of hits) {
        if (seen.has(hit.url)) continue;
        seen.add(hit.url);
        const bucket = buckets.get(hit.channel) ?? [];
        bucket.push(hit);
        buckets.set(hit.channel, bucket);
    }
    const out: Hit[] = [];
    for (let index = 0; out.length < limit; index++) {
        let moved = false;
        for (const bucket of buckets.values()) {
            if (out.length >= limit) break;
            if (bucket[index]) { out.push(bucket[index]); moved = true; }
        }
        if (!moved) break;
    }
    return out;
}

async function extractClaims(source: SourceDoc, per: number): Promise<Claim[]> {
    const answer = await chatWithProvider([{
        role: "user",
        content: `从下面这篇资料里抽出最多 ${per} 条「有事实、有数字或有明确结论」的断言。
每条都配一句原文引用（必须是文章里连续出现的句子）。
只输出 JSON：{"claims":[{"claim":"…","quote":"…"}]}
标题：${source.title}
正文：
${clip(source.text, 12000)}`,
    }]);
    const parsed = parseJson<{ claims?: { claim?: string; quote?: string }[] }>(answer);
    const claims = Array.isArray(parsed?.claims) ? parsed!.claims : [];
    return claims
        .filter(item => typeof item?.claim === "string" && item.claim.trim())
        .slice(0, per)
        .map(item => {
            const quote = typeof item.quote === "string" ? item.quote.trim() : "";
            // 引用要在正文里真的找得到，找不到就标「待验证」
            const verified = Boolean(quote) && source.text.includes(quote.slice(0, 20));
            return { claim: item.claim!.trim(), quote, source: source.index, verified };
        });
}

function renderReport(topic: string, body: string, claims: Claim[], sources: SourceDoc[], channels: string[], depth: Depth): string {
    const stamp = new Date().toISOString().slice(0, 10);
    const evidence = claims.length
        ? ["## 证据表", "", "| 断言 | 来源 | 渠道 | 状态 |", "| --- | --- | --- | --- |",
           ...claims.map(claim => {
               const source = sources.find(item => item.index === claim.source);
               return `| ${claim.claim.replace(/\|/g, "\\|")} | [${claim.source}] | ${source?.channel ?? "-"} | ${claim.verified ? "已核对" : "待验证"} |`;
           }), ""]
        : [];
    const list = ["## 来源", "", ...sources.map(item => `[${item.index}] ${item.title} — ${item.url} — ${item.channel}（仅摘要）`), ""];
    const method = ["## 方法", "", `- 主题：${topic}`, `- 深度：${depth}`, `- 渠道：${channels.join("、")}`, `- 检索时间：${stamp}`, ""];
    return [
        "---",
        `title: ${JSON.stringify(topic)}`,
        `type: research`,
        `created: ${stamp}`,
        `depth: ${depth}`,
        `channels: [${channels.join(", ")}]`,
        "---",
        "",
        `# ${topic}`,
        "",
        body.trim(),
        "",
        ...evidence,
        ...list,
        ...method,
    ].join("\n");
}

export async function runResearch(input: {
    topic: string;
    depth: Depth;
    channels: Channel[];
    onEvent: (event: ResearchEvent) => void;
    isCancelled: () => boolean;
    isPaused: () => boolean;
    waitWhilePaused: () => Promise<void>;
}): Promise<ResearchResult> {
    const { topic, depth, channels, onEvent, isCancelled, isPaused, waitWhilePaused } = input;
    const config = DEPTHS[depth];
    const warnings: string[] = [];
    const ensure = async () => {
        if (isPaused()) await waitWhilePaused();
        if (isCancelled()) throw new Error("已取消");
    };

    const planResult = await plan(topic, depth, channels);
    onEvent({ kind: "plan", plan: planResult, message: t("research.eventPlan", { count: planResult.sub_questions.length }) });
    await ensure();

    const hits: Hit[] = [];
    // 渠道之间互不依赖：并发跑，单个失败只记一条警告。
    const searched = await Promise.all(channels.map(async channel => {
        onEvent({ kind: "search", channel, status: "running", count: 0, items: [], message: t("research.running") });
        try {
            const found = await invoke<Hit[]>("research_search", {
                channel,
                queries: queriesFor(channel, planResult, topic),
                limit: config.perQuery,
            });
            onEvent({ kind: "search", channel, status: "done", count: found.length, items: found.slice(0, 6), message: t("research.hits", { count: found.length }) });
            return found;
        } catch (cause) {
            onEvent({ kind: "search", channel, status: "error", count: 0, items: [], message: String(cause) });
            warnings.push(`${channel}：${String(cause)}`);
            return [];
        }
    }));
    hits.push(...searched.flat());
    await ensure();
    if (!hits.length) throw new Error(warnings[0] || "所有渠道都没有结果");

    const picked = pickSources(hits, config.sources);
    const fetched = await invoke<{ url: string; ok: boolean; chars: number; text: string; error: string }[]>(
        "research_fetch",
        { urls: picked.map(hit => hit.url), limit: config.sources },
    );
    const sources: SourceDoc[] = [];
    for (const item of fetched) {
        const hit = picked.find(entry => entry.url === item.url);
        if (!hit) continue;
        sources.push({
            index: sources.length + 1,
            title: hit.title,
            url: item.url,
            channel: hit.channel,
            text: item.text,
            chars: item.chars,
            ok: item.ok,
            error: item.error || undefined,
        });
    }
    onEvent({
        kind: "fetch",
        total: picked.length,
        sources: sources.map(({ text: _text, ...rest }) => rest),
        message: t("research.eventFetch", { done: sources.filter(item => item.ok).length, total: picked.length }),
    });
    const usable = sources.filter(source => source.ok);
    if (!usable.length) throw new Error("抓不到可读正文");
    await ensure();

    const claims: Claim[] = [];
    // 逐源抽断言是模型调用里最慢的一段：开三个并发，既快又不至于把配额打满。
    const queue = [...usable];
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length) {
            const source = queue.shift();
            if (!source || isCancelled()) return;
            try {
                const extracted = await extractClaims(source, config.claimsPerSource);
                claims.push(...extracted);
                onEvent({ kind: "extract", source: source.index, title: source.title, count: extracted.length, message: `${source.title} · ${extracted.length}` });
            } catch (cause) {
                warnings.push(`抽取 ${source.title}：${String(cause)}`);
            }
        }
    }));
    await ensure();
    if (!claims.length) throw new Error("没有抽到可用的断言");
    claims.sort((a, b) => a.source - b.source);
    onEvent({ kind: "extract-total", total: claims.length, message: t("research.eventClaims", { count: claims.length }) });

    onEvent({ kind: "synthesize", message: t("research.eventSynthesize") });
    const evidence = claims.map(claim => `[${claim.source}] ${claim.claim}`).join("\n");
    const body = await chatWithProvider([{
        role: "user",
        content: `基于下列断言，写一份中文调研简报。
要求：
1. 结论先行：3-5 条 TL;DR；
2. 正文 2-4 节，每条断言后用 [编号] 标注来源；
3. 只用给定的断言，不要新增事实；只有单一来源支持的断言在句末标「（单源，待验证）」；
4. 结尾写「未解决的问题 / 下一步」2-3 条；
5. 直接输出 Markdown，不要代码块。
主题：${topic}
断言（[编号] 来自来源列表）：
${evidence}
来源：
${sources.map(source => `[${source.index}] ${source.title} — ${source.url} — ${source.channel}`).join("\n")}`,
    }]);

    const markdown = renderReport(topic, body, claims, sources, channels, depth);
    const saved = await invoke<{ file: string }>("research_save", {
        query: topic,
        markdown,
        meta: { depth, channels, plan: planResult, sources: sources.map(({ text: _text, ...rest }) => rest), claims },
        dir: useSettings.getState().researchRoot,
    });
    onEvent({ kind: "save", file: saved.file, message: t("research.eventSave", { file: saved.file }) });
    onEvent({ kind: "done", message: t("research.eventDone") });
    return { markdown, file: saved.file, claims, sources, warnings };
}
