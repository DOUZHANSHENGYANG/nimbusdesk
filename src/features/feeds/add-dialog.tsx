import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Rss } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFeeds } from "@/stores/feeds";
import { normalizeFeedUrl, probeFeed, type FeedPreview } from "@/sources/rss";
import { useSubscriptions, type FeedKind, type FeedSource } from "./subscriptions";

const KINDS: FeedKind[] = ["rss", "searxng", "cn-social", "page", "opencli"];
const KIND_LABEL: Record<FeedKind, string> = {
    rss: "feeds.kindRss",
    searxng: "feeds.kindSearch",
    "cn-social": "feeds.kindSocial",
    page: "feeds.kindPage",
    opencli: "feeds.kindCli",
};
// 只留能直接用的地址：带 ... 的模板填进去必然探测失败，等于把用户送进错误态。
const PRESETS = (t: (key: string) => string) => [
    { label: t("feeds.presetJuya"), url: "https://daily.juya.uk/rss.xml" },
];

/** 新增/编辑一个订阅源。字段按 kind 切换，只显示这种源真正用得上的那几个。 */
export function AddFeedDialog({ open, onOpenChange, source }: {
    open: boolean;
    onOpenChange: (value: boolean) => void;
    /** 传了就是编辑这个源（id 不变），不传是新增。 */
    source?: FeedSource;
}) {
    const { t } = useTranslation();
    const [kind, setKind] = useState<FeedKind>("rss");
    const [name, setName] = useState("");
    const [url, setUrl] = useState("");
    const [queries, setQueries] = useState("");
    const [sites, setSites] = useState("");
    const [site, setSite] = useState("");
    const [command, setCommand] = useState("");
    const [query, setQuery] = useState("");
    const [interval, setIntervalValue] = useState("60");
    const [preview, setPreview] = useState<FeedPreview | null>(null);
    const [error, setError] = useState("");
    const [probing, setProbing] = useState(false);
    const request = useRef(0);
    const controller = useRef<AbortController | null>(null);
    const cancel = () => { request.current++; controller.current?.abort(); };
    useEffect(() => {
        if (!open) {
            cancel();
            reset();
            return;
        }
        if (!source) return;
        setKind(source.kind);
        setName(source.name);
        setUrl(typeof source.config.url === "string" ? source.config.url : "");
        setQueries(Array.isArray(source.config.queries) ? source.config.queries.join("\n") : "");
        setSites(typeof source.config.sites === "string" ? source.config.sites : "");
        setSite(typeof source.config.site === "string" ? source.config.site : "");
        setCommand(typeof source.config.command === "string" ? source.config.command : "");
        setQuery(typeof source.config.query === "string" ? source.config.query : "");
        setIntervalValue(String(source.intervalMinutes || 60));
        setPreview(null);
        setError("");
        return () => cancel();
    }, [open, source]);
    function reset() {
        setKind("rss");
        setName("");
        setUrl("");
        setQueries("");
        setSites("");
        setSite("");
        setCommand("");
        setQuery("");
        setIntervalValue("60");
        setPreview(null);
        setError("");
        setProbing(false);
    }
    function changeUrl(value: string) {
        if (name === preview?.title) setName("");
        cancel();
        setUrl(value);
        setPreview(null);
        setError("");
        setProbing(false);
    }
    async function probe() {
        cancel();
        const current = request.current;
        let normalized: string;
        try {
            normalized = normalizeFeedUrl(url);
        } catch {
            setError(t("feeds.errUrl"));
            return;
        }
        const abort = new AbortController();
        controller.current = abort;
        setError("");
        setPreview(null);
        setProbing(true);
        try {
            const result = await probeFeed(normalized, abort.signal);
            if (current !== request.current) return;
            setPreview(result);
            setUrl(result.url);
            setName(value => value.trim() ? value : result.title);
        } catch (cause) {
            if (current === request.current) setError(`${t("feeds.probeFail")} ${cause instanceof Error ? cause.message : String(cause)}`);
        } finally {
            if (current === request.current) setProbing(false);
        }
    }
    const words = queries.split("\n").map(item => item.trim()).filter(Boolean);
    const canSave = kind === "rss" || kind === "page"
        ? url.trim().length > 0
        : kind === "opencli"
            ? site.trim().length > 0
            : words.length > 0;
    function config(): Record<string, unknown> {
        if (kind === "rss" || kind === "page") return { url: preview?.url ?? url.trim() };
        if (kind === "opencli") return { site: site.trim(), command: command.trim() || "search", query: query.trim() };
        if (kind === "cn-social") return { queries: words, sites: sites.trim() };
        return { queries: words };
    }
    async function save() {
        if (!canSave) return;
        try {
            const saved = await useSubscriptions.getState().save({
                id: source?.id,
                kind,
                name: name.trim(),
                config: config(),
                enabled: source?.enabled ?? true,
                intervalMinutes: Math.max(5, Number(interval) || 60),
            });
            if (preview) useFeeds.getState().seedCache(saved.id, preview.entries);
            useFeeds.getState().selectSource(saved.id);
            toast.success(t(source ? "feeds.savedSource" : "feeds.subscribed"));
            onOpenChange(false);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }
    return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle className="flex items-center gap-2 text-base"><Rss className="size-4 text-brand"/>{t(source ? "feeds.editSource" : "feeds.addSourceTitle")}</DialogTitle></DialogHeader>
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2"><Label htmlFor="source-kind">{t("feeds.kindLabel")}</Label>
          <select id="source-kind" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={kind} onChange={event => { setKind(event.target.value as FeedKind); setPreview(null); setError(""); }}>
            {KINDS.map(item => <option key={item} value={item}>{t(KIND_LABEL[item])}</option>)}
          </select>
        </div>
        <div className="space-y-2"><Label htmlFor="source-interval">{t("feeds.interval")}</Label>
          <Input id="source-interval" inputMode="numeric" value={interval} onChange={event => setIntervalValue(event.target.value.replace(/\D/g, ""))}/>
        </div>
      </div>
      {(kind === "rss" || kind === "page") && <div className="space-y-2"><Label htmlFor="feed-url">{t("feeds.url")}</Label><div className="flex items-center gap-2"><Input id="feed-url" className="min-w-0 flex-1" value={url} onChange={event => changeUrl(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && kind === "rss") { event.preventDefault(); void probe(); } }} placeholder="https://example.com/feed.xml"/>{kind === "rss" && <Button size="sm" variant="outline" disabled={probing || !url.trim()} onClick={() => void probe()}>{probing ? <Loader2 className="size-3.5 animate-spin"/> : null}{t(probing ? "feeds.probing" : "feeds.probe")}</Button>}</div></div>}
      {kind === "rss" && <div className="flex flex-wrap gap-2">{PRESETS(t).map(preset => <button type="button" key={preset.url} className="rounded-full border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => changeUrl(preset.url)}>{preset.label}</button>)}</div>}
      {(kind === "searxng" || kind === "cn-social") && <div className="space-y-2"><Label htmlFor="source-queries">{t("feeds.queries")}</Label><textarea id="source-queries" className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm" value={queries} onChange={event => setQueries(event.target.value)} placeholder={t("feeds.queriesHint")}/></div>}
      {kind === "cn-social" && <div className="space-y-2"><Label htmlFor="source-sites">{t("feeds.sites")}</Label><Input id="source-sites" value={sites} onChange={event => setSites(event.target.value)} placeholder="zhihu,xiaohongshu,douyin"/></div>}
      {kind === "opencli" && <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2"><Label htmlFor="source-site">{t("feeds.site")}</Label><Input id="source-site" value={site} onChange={event => setSite(event.target.value)} placeholder="bilibili"/></div>
        <div className="space-y-2"><Label htmlFor="source-command">{t("feeds.command")}</Label><Input id="source-command" value={command} onChange={event => setCommand(event.target.value)} placeholder="search"/></div>
        <div className="col-span-2 space-y-2"><Label htmlFor="source-query">{t("feeds.query")}</Label><Input id="source-query" value={query} onChange={event => setQuery(event.target.value)} placeholder="Tauri"/></div>
      </div>}
      {error && <p role="alert" className="text-xs leading-5 text-destructive">{error}</p>}
      {preview && <div className="space-y-3 border-y py-4"><p role="status" className="text-xs text-muted-foreground">{t("feeds.probeReady", { count: preview.entries.length })}</p><ol className="space-y-2">{preview.entries.slice(0, 3).map(entry => <li className="truncate text-sm" key={entry.url}>{entry.title}</li>)}</ol></div>}
      <div className="space-y-2"><Label htmlFor="feed-name">{t("feeds.name")}</Label><Input id="feed-name" value={name} onChange={event => setName(event.target.value)}/></div>
    </div><footer className="mt-1 flex justify-end gap-2"><Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>{t("feeds.cancel")}</Button><Button size="sm" disabled={!canSave} onClick={() => void save()}>{t("feeds.saveSub")}</Button></footer>
  </DialogContent></Dialog>;
}
