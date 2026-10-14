/** 混合模式 AI 加工：手动触发的摘要/简报（token 可控） */
import { chatStream } from "@/lib/llm";
import { extractUrl } from "@/search/tavily";
import type { SourceEntry } from "@/sources/types";

export async function summarizeList(
  sourceName: string,
  entries: SourceEntry[],
  onDelta: (chunk: string) => void,
): Promise<string> {
  const lines = entries
    .slice(0, 30)
    .map((e, i) => {
      const hover = e.extra?.hover ? ` — ${e.extra.hover.slice(0, 120)}` : "";
      return `${i + 1}. ${e.title}${hover}`;
    })
    .join("\n");

  return chatStream(
    [
      {
        role: "system",
        content:
          "你是资讯编辑。把给定条目浓缩成一份简明中文简报：按主题归组，每条一行要点，最后单独列出最值得点开看的 3-5 条（附序号）。",
      },
      { role: "user", content: `来源：${sourceName}\n\n条目：\n${lines}` },
    ],
    onDelta,
  );
}

export async function summarizeUrl(
  url: string,
  onDelta: (chunk: string) => void,
): Promise<string> {
  const content = await extractUrl(url);
  if (!content) throw new Error("抓取不到正文（Tavily extract 无结果），该页可能需要登录或是纯视频页");

  return chatStream(
    [
      {
        role: "system",
        content: "你是技术编辑。用中文把给定文章总结为：一句话结论 + 3-5 个要点 + 对读者的价值判断。忠实原文，不编造。",
      },
      { role: "user", content: content.slice(0, 12000) },
    ],
    onDelta,
  );
}
