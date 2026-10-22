import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
// 版式来自开发知识那套，显式 import：不靠别的页面顺手带进来
import "@/features/knowledge/markdown.css";

/**
 * 工具箱里的 Markdown 预览。
 *
 * 版式直接复用开发知识那套 `.note-markdown` —— 两处各写一份排版规则必然漂移。
 * 与源侧的差异：源侧是 marked + dompurify 手动 sanitize，这里用 react-markdown，
 * 它默认不渲染原始 HTML，安全边界不需要额外一个依赖。
 */
export function MarkdownView({ source, className }: { source: string; className?: string }) {
  return (
    <div className={cn("note-markdown select-text", className)}>
      <Markdown remarkPlugins={[remarkGfm]}>{source}</Markdown>
    </div>
  );
}
