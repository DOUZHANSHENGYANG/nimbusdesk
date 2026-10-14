import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCustomFeeds } from "@/stores/custom-feeds";
import { useFeeds } from "@/stores/feeds";

function hashId(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const PRESETS = (t: (k: string) => string) => [
  { label: t("feeds.presetYT"), url: "https://www.youtube.com/feeds/videos.xml?channel_id=..." },
  { label: t("feeds.presetBili"), url: "https://rsshub.app/bilibili/user/video/..." },
  { label: t("feeds.presetWeibo"), url: "https://rsshub.app/weibo/user/..." },
  { label: t("feeds.presetZhihu"), url: "https://rsshub.app/zhihu/people/activities/..." },
  { label: t("feeds.presetGH"), url: "https://rsshub.app/github/user/..." },
  { label: t("feeds.presetTG"), url: "https://rsshub.app/telegram/channel/..." },
];

export function AddFeedDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  const addFeed = useCustomFeeds((s) => s.add);
  const selectSource = useFeeds((s) => s.selectSource);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [group, setGroup] = useState("订阅");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setName("");
    setUrl("");
    setGroup("订阅");
    setError(null);
  };

  const presets = PRESETS(t);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{t("feeds.addRssTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("feeds.name")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("feeds.url")}</Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/feed.xml"
            />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("feeds.group")}</Label>
            <Input value={group} onChange={(e) => setGroup(e.target.value)} />
          </div>
          <div>
            <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">{t("feeds.presets")}</div>
            <div className="flex flex-wrap gap-1.5">
              {presets.map((p) => (
                <button
                  key={p.label}
                  onClick={() => {
                    setUrl(p.url);
                    if (!name.trim()) setName(p.label);
                    setError(null);
                  }}
                  className="rounded-full border px-2.5 py-1 text-[11px] transition-colors hover:bg-accent"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("feeds.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={saving}
            onClick={() => {
              const u = url.trim();
              if (!/^https?:\/\//i.test(u)) {
                setError(t("feeds.errUrl"));
                return;
              }
              if (!name.trim()) {
                setError(t("feeds.errName"));
                return;
              }
              setSaving(true);
              const id = `rss:${hashId(u)}`;
              addFeed({ id, name: name.trim(), group: group.trim() || "订阅", url: u });
              setSaving(false);
              onOpenChange(false);
              reset();
              selectSource(id);
            }}
          >
            {saving ? t("feeds.saving") : t("feeds.saveSub")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
