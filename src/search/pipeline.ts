/**
 * 搜索管道：searchWeb → 组上下文 → LLM 流式综合（带 [n] 引用）。
 *
 * 没配置 AI 提供商时**不算失败**：检索结果照样返回，只是不综合成答案。
 * 「搜索」这件事本身不依赖模型，只有「综合答案」依赖 —— 之前两者绑在一起，
 * 导致切成奇妙搜索源后仍然报 `AI_NO_PROVIDER`。
 */
import { chatStream } from "@/lib/llm";
import { inTauri } from "@/lib/tauri";
import { providersReady, useProviders } from "@/features/ai/providers";
import { selectProvider } from "@/features/ai/core";
import { searchWeb } from "@/search";
import type { WebResult } from "./tavily";

const SYSTEM = `你是技术调研助手。基于给定的搜索结果回答用户问题：
- 用中文回答，简明扼要、信息密度高，优先给出可操作的结论
- 引用时在对应句子末尾标注来源编号，如 [1][2]，编号对应搜索结果的序号
- 搜"开源项目/技术方案"类问题时，给出项目名 + 一句话定位 + 选型建议
- 搜索结果不足以回答时直接说明缺什么，绝不编造`;

export interface AskResult {
  /** 没有可用 AI 提供商时为空字符串 */
  answer: string;
  sources: WebResult[];
  /** 是否真的走了模型综合。false 表示只有检索结果 */
  synthesized: boolean;
}

/**
 * 现在能不能综合答案：需要一个可解析的默认文本服务商，且运行在桌面端
 * （模型调用走 Rust 代理，浏览器预览里没有 IPC）。
 */
export function aiAvailable(): boolean {
  if (!inTauri) return false;
  try {
    selectProvider(useProviders.getState(), false);
    return true;
  } catch {
    return false;
  }
}

export async function ask(
  query: string,
  onDelta: (chunk: string) => void,
): Promise<AskResult> {
  const results = await searchWeb(query, 5);
  if (!results.length) throw new Error("搜索无结果，换个关键词试试");

  await providersReady();
  if (!aiAvailable()) return { answer: "", sources: results, synthesized: false };

  const context = results
    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n内容: ${r.content}`)
    .join("\n\n");

  const answer = await chatStream(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: `问题：${query}\n\n搜索结果：\n${context}` },
    ],
    onDelta,
  );

  return { answer, sources: results, synthesized: true };
}
