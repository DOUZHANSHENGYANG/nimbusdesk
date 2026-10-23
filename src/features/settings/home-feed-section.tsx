import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCustomFeeds } from "@/stores/custom-feeds";
import { useSettings } from "@/stores/settings";
import { mergedSources } from "@/sources/custom";

/** 下拉里「自动」那一项的值：不落盘成任何真实渠道 id，免得渠道改名/删除后指向失效。 */
const AUTO = "__auto";

/**
 * 主页「资讯」卡片显示哪个渠道。
 *
 * 默认（自动）= 订阅顺序里的第一个源：自定义订阅在 `mergedSources()` 里排在静态渠道前面，
 * 所以就是「我添加的第一个 RSS」。想固定看某个源（比如 AI 早报）就在这里选。
 */
export function HomeFeedSection() {
  const { t } = useTranslation();
  const homeFeedSource = useSettings((s) => s.homeFeedSource);
  const setHomeFeedSource = useSettings((s) => s.setHomeFeedSource);
  // 订阅列表变了要重算可选渠道，所以订阅 feeds 而不是只在渲染时读一次 store
  const customFeeds = useCustomFeeds((s) => s.feeds);
  const sources = useMemo(() => mergedSources(), [customFeeds]);
  const customIds = new Set(customFeeds.map((feed) => feed.id));
  const value = homeFeedSource && sources.some((source) => source.id === homeFeedSource) ? homeFeedSource : AUTO;

  return <Card>
    <CardHeader>
      <CardTitle>{t("settings.homeFeed.title")}</CardTitle>
      <CardDescription>{t("settings.homeFeed.hint")}</CardDescription>
    </CardHeader>
    <CardContent>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-muted-foreground">{t("settings.homeFeed.source")}</span>
        <div className="w-64 min-w-0">
          <Select value={value} onValueChange={(next) => setHomeFeedSource(next === AUTO ? null : next)}>
            <SelectTrigger aria-label={t("settings.homeFeed.source")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectItem value={AUTO}>{t("settings.homeFeed.auto")}</SelectItem>
              {sources.map((source) => (
                <SelectItem key={source.id} value={source.id}>
                  {customIds.has(source.id) ? `${source.name} · ${t("settings.homeFeed.custom")}` : source.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </CardContent>
  </Card>;
}
