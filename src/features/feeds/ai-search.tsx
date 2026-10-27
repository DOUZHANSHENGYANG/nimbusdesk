import { useTranslation } from "react-i18next";
import { Search, Loader2, Settings2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAiSearch } from "./search-state";
import { useAiSettings } from "@/stores/ai";
import { openExternal } from "@/lib/open";

/** 搜索视图：检索结果始终列出，配了 AI 才额外综合答案 */
export function AiSearchView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const query = useAiSearch((s) => s.query);
  const asking = useAiSearch((s) => s.asking);
  const answer = useAiSearch((s) => s.answer);
  const sources = useAiSearch((s) => s.sources);
  const synthesized = useAiSearch((s) => s.synthesized);
  const error = useAiSearch((s) => s.error);
  const setQuery = useAiSearch((s) => s.setQuery);
  const run = useAiSearch((s) => s.run);
  const provider = useAiSettings((s) =>
    s.searchProvider === "eos"
      ? "eos"
      : s.searchProvider === "tavily" || (s.searchProvider === "auto" && !!s.tavilyApiKey)
        ? "tavily"
        : "bing",
  );

  const hasOutput = !!answer || !!sources.length;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="border-b px-4 py-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <input
            aria-label={t("feeds.tabAi")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("feeds.searchPh")}
            className="h-9 flex-1 rounded-md border border-input bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring/40"
          />
          <Button type="submit" disabled={asking}>
            {asking ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            {asking ? t("feeds.asking") : t("feeds.ask")}
          </Button>
        </form>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {t("feeds.searchBackend")}: {provider === "eos" ? t("feeds.eos") : provider === "tavily" ? t("feeds.tavily") : t("feeds.bing")}
        </p>
      </header>

      <ScrollArea className="min-h-0 flex-1 p-4">
        {error ? <div role="alert" className="mb-3 text-sm text-destructive">{t("feeds.searchFail")}{error}</div> : null}

        {!hasOutput && asking ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-4 animate-pulse rounded bg-muted" style={{ width: `${90 - i * 12}%` }} />
            ))}
            <p className="pt-2 text-xs text-muted-foreground">{t("feeds.searching")}</p>
          </div>
        ) : null}

        {hasOutput ? (
          <div className="max-w-3xl">
            {answer ? (
              <div aria-label={t("feeds.aiAnswer")} className="whitespace-pre-wrap text-sm leading-relaxed">{answer}</div>
            ) : null}

            {/* 没配 AI：明确说明只有结果，并给一条去配置的入口 */}
            {!synthesized ? (
              <div className="mt-1 flex flex-wrap items-center gap-2 rounded-md border border-input bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                <span className="min-w-0 flex-1">{t("feeds.noAiProvider")}</span>
                <Button size="sm" variant="outline" onClick={() => navigate("/settings")}>
                  <Settings2 className="size-3.5" />{t("feeds.goAiSettings")}
                </Button>
              </div>
            ) : null}

            {sources.length ? (
              <div className={answer || !synthesized ? "mt-4 border-t pt-3" : ""}>
                <div className="mb-2 text-[11px] font-medium text-muted-foreground">
                  {t("feeds.sources")}
                  <span className="ml-1.5 tabular-nums">{sources.length}</span>
                </div>
                <ul className="space-y-1">
                  {sources.map((s, i) => (
                    <li key={s.url}>
                      <button
                        onClick={() => void openExternal(s.url)}
                        className="w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                      >
                        <Badge variant="secondary" className="mr-1.5 px-1.5">[{i + 1}]</Badge>
                        <span className="align-middle">{s.title}</span>
                        <span className="ml-2 align-middle text-muted-foreground">
                          {hostOf(s.url)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {!hasOutput && !asking && !error ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t("feeds.askHint")}
          </div>
        ) : null}
      </ScrollArea>
    </div>
  );
}

/** 磁力/ed2k 这类结果没有 hostname，别让整块渲染炸掉 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url.slice(0, 40);
  } catch {
    return url.slice(0, 40);
  }
}
