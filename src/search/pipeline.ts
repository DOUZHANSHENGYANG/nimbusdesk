/** 问答管道：searchWeb → 组上下文 → LLM 流式综合（带 [n] 引用） */
import { chatStream } from "@/lib/llm";
import { searchWeb } from "@/search";
import type { WebResult } from "./tavily";

const SYSTEM = `你是技术调研助手。基于给定的搜索结果回答用户问题：
- 用中文回答，简明扼要、信息密度高，优先给出可操作的结论
- 引用时在对应句子末尾标注来源编号，如 [1][2]，编号对应搜索结果的序号
- 搜"开源项目/技术方案"类问题时，给出项目名 + 一句话定位 + 选型建议
- 搜索结果不足以回答时直接说明缺什么，绝不编造`;

export async function ask(
  query: string,
  onDelta: (chunk: string) => void,
): Promise<{ answer: string; sources: WebResult[] }> {
  const results = await searchWeb(query, 5);
  if (!results.length) throw new Error("搜索无结果，换个关键词试试");

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

  return { answer, sources: results };
}
