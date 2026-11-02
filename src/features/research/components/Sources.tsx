import { ExternalLink, FileText } from "lucide-react";

export interface SourceItem {
    index: number;
    title: string;
    url: string;
    channel: string;
    chars?: number;
    ok?: boolean;
}

const HOST = (url: string): string => {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return url;
    }
};

/** 来源清单：编号即报告里的 [n]，点开原站。 */
export function Sources({ items, title = "来源", channelLabel, summaryLabel }: {
    items: SourceItem[];
    title?: string;
    channelLabel?: (channel: string) => string;
    summaryLabel?: string;
}) {
    if (items.length === 0) return null;
    const label = channelLabel ?? ((channel: string) => channel);
    return <div className="space-y-1.5">
        <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{title} · {items.length}</div>
        <div className="grid gap-1.5 sm:grid-cols-2">
            {items.map(source => <a key={`${source.index}-${source.url}`} href={source.url} target="_blank" rel="noreferrer noopener"
                className="group flex items-start gap-2 rounded-lg border border-border bg-card px-2 py-1.5 transition-colors hover:border-brand/50">
                <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded bg-muted font-mono text-[10px] text-muted-foreground">{source.index}</span>
                <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1">
                        <FileText className="size-3 shrink-0 text-muted-foreground"/>
                        <span className="truncate text-[11px] text-foreground">{source.title}</span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span className="rounded bg-muted px-1">{label(source.channel)}</span>
                        <span className="truncate">{HOST(source.url)}</span>
                        {typeof source.chars === "number" && source.chars > 0 && <span className="font-mono">{source.chars}c</span>}
                        {source.ok === false && summaryLabel && <span className="text-warning">{summaryLabel}</span>}
                    </span>
                </span>
                <ExternalLink className="mt-1 size-3 shrink-0 text-muted-foreground/50 group-hover:text-brand"/>
            </a>)}
        </div>
    </div>;
}
