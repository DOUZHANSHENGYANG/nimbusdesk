import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

/** 渲染 Markdown 报告（消毒后注入），带复制。 */
export function Response({ markdown, title }: { markdown: string; title?: string }) {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);
    const html = useMemo(() => {
        // 报告来自模型 + 网页，属不可信输入：marked 负责结构，DOMPurify 负责安全
        const cleaned = markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
        const parsed = marked.parse(cleaned, { async: false }) as string;
        return DOMPurify.sanitize(parsed, {
            FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "input", "link", "meta"],
            FORBID_ATTR: ["style", "onerror", "onclick", "onload"],
            ALLOW_DATA_ATTR: false,
        });
    }, [markdown]);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(markdown);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // 剪贴板不可用则忽略
        }
    };
    return <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-[11px] font-bold text-foreground">{title ?? t("research.record")}</span>
            <button type="button" onClick={() => void copy()}
                className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-muted-foreground outline-none hover:bg-brand/10 hover:text-brand focus-visible:ring-2 focus-visible:ring-ring">
                {copied ? <Check className="size-3"/> : <Copy className="size-3"/>}
                {t(copied ? "research.copied" : "research.copyMarkdown")}
            </button>
        </div>
        <div className="md-body selectable px-4 py-3" dangerouslySetInnerHTML={{ __html: html }}/>
    </div>;
}
