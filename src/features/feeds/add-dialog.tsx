import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Rss } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCustomFeeds } from "@/stores/custom-feeds";
import { useFeeds } from "@/stores/feeds";
import { normalizeFeedUrl, probeFeed, type FeedPreview } from "@/sources/rss";
function hashId(input: string): string {
    let h = 5381;
    for (let i = 0; i < input.length; i++)
        h = ((h << 5) + h + input.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}
const PRESETS = (t: (key: string) => string) => [
    { label: t("feeds.presetJuya"), url: "https://daily.juya.uk/rss.xml" },
    { label: t("feeds.presetYT"), url: "https://www.youtube.com/feeds/videos.xml?channel_id=..." },
    { label: t("feeds.presetBili"), url: "https://rsshub.app/bilibili/user/video/..." },
    { label: t("feeds.presetGH"), url: "https://rsshub.app/github/user/..." },
];
export function AddFeedDialog({ open, onOpenChange }: {
    open: boolean;
    onOpenChange: (value: boolean) => void;
}) {
    const { t } = useTranslation();
    const [name, setName] = useState("");
    const [url, setUrl] = useState("");
    const [group, setGroup] = useState("");
    const [preview, setPreview] = useState<FeedPreview | null>(null);
    const [error, setError] = useState("");
    const [probing, setProbing] = useState(false);
    const request = useRef(0);
    const controller = useRef<AbortController | null>(null);
    const cancel = () => { request.current++; controller.current?.abort(); };
    useEffect(() => {
        if (!open) {
            cancel();
            setName("");
            setUrl("");
            setGroup("");
            setPreview(null);
            setError("");
            setProbing(false);
        }
        return () => cancel();
    }, [open]);
    function changeUrl(value: string) {
        if (name === preview?.title)
            setName('');
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
        }
        catch {
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
            if (current !== request.current)
                return;
            setPreview(result);
            setUrl(result.url);
            setName(value => value.trim() ? value : result.title);
        }
        catch (cause) {
            if (current === request.current)
                setError(`${t("feeds.probeFail")} ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        finally {
            if (current === request.current)
                setProbing(false);
        }
    }
    function save() {
        if (!preview || probing || !name.trim())
            return;
        const feeds = useCustomFeeds.getState();
        const existing = feeds.feeds.find(feed => { try {
            return normalizeFeedUrl(feed.url) === preview.url;
        }
        catch {
            return false;
        } });
        const id = existing?.id ?? `rss:${hashId(preview.url)}`;
        useFeeds.getState().seedCache(id, preview.entries);
        if (!existing)
            feeds.add({ id, name: name.trim(), group: group.trim() || "订阅", url: preview.url });
        useFeeds.getState().selectSource(id);
        toast.success(t(existing ? "feeds.alreadySubscribed" : "feeds.subscribed"));
        onOpenChange(false);
    }
    return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle className="flex items-center gap-2 text-base"><Rss className="size-4 text-brand"/>{t("feeds.addRssTitle")}</DialogTitle></DialogHeader>
    <div className="space-y-5">
      <div className="space-y-2"><Label htmlFor="feed-url">{t("feeds.url")}</Label><div className="flex items-center gap-2"><Input id="feed-url" className="min-w-0 flex-1" value={url} onChange={event => changeUrl(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') {
        event.preventDefault();
        void probe();
    } }} placeholder="https://example.com/feed.xml"/><Button size="sm" variant="outline" disabled={probing || !url.trim()} onClick={() => void probe()}>{probing ? <Loader2 className="size-3.5 animate-spin"/> : null}{t(probing ? "feeds.probing" : "feeds.probe")}</Button></div><p className="text-xs leading-5 text-muted-foreground">{t("feeds.probeHint")}</p></div>
      <div className="flex flex-wrap gap-2">{PRESETS(t).map(preset => <button type="button" key={preset.url} className="rounded-full border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => changeUrl(preset.url)}>{preset.label}</button>)}</div>
      {error && <p role="alert" className="text-xs leading-5 text-destructive">{error}</p>}
      {preview && <div className="space-y-3 border-y py-4"><p role="status" className="text-xs text-muted-foreground">{t("feeds.probeReady", { count: preview.entries.length })}</p><ol className="space-y-2">{preview.entries.slice(0, 3).map(entry => <li className="truncate text-sm" key={entry.url}>{entry.title}</li>)}</ol></div>}
      <div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor="feed-name">{t("feeds.name")}</Label><Input id="feed-name" value={name} onChange={event => setName(event.target.value)}/></div><div className="space-y-2"><Label htmlFor="feed-group">{t("feeds.group")}</Label><Input id="feed-group" value={group} placeholder={t("feeds.groupSub")} onChange={event => setGroup(event.target.value)}/></div></div>
    </div><footer className="mt-1 flex justify-end gap-2"><Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>{t("feeds.cancel")}</Button><Button size="sm" disabled={!preview || probing || !name.trim()} onClick={save}>{t("feeds.saveSub")}</Button></footer>
  </DialogContent></Dialog>;
}
