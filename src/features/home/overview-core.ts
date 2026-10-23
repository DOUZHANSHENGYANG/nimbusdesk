/**
 * 首页概览的聚合逻辑：三件小事，都只跟“排序与取前几条”有关，所以做成纯函数好测。
 * 「今日计划」不需要在这里算——plans/types 的 dayProgress 与 childrenOf 已经是那一层的口径。
 */

/** 待办卡片：未完成的工作项按截止日排，没有截止日的排最后（而不是被当成“最早”）。 */
export function prioritizeWorkItems<T extends { status: string; deadline: string | null }>(items: readonly T[], limit = 5): T[] {
  return items
    .filter(item => item.status === "todo" || item.status === "doing")
    .sort((a, b) => (a.deadline ?? "9999-12-31").localeCompare(b.deadline ?? "9999-12-31"))
    .slice(0, Math.max(0, limit));
}

/** 资讯卡片：把各渠道的条目并成一条时间线，按发布时间倒序；同一条（同 id）只留先遇到的那份。 */
export function latestEntries<T extends { id: string; pubDate?: number }>(entriesBySource: Record<string, readonly T[]>, limit = 4): { sourceId: string; entry: T }[] {
  const seen = new Set<string>();
  const all: { sourceId: string; entry: T }[] = [];
  for (const [sourceId, entries] of Object.entries(entriesBySource)) {
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      all.push({ sourceId, entry });
    }
  }
  return all.sort((a, b) => (b.entry.pubDate ?? 0) - (a.entry.pubDate ?? 0)).slice(0, Math.max(0, limit));
}

/** 相对时间：卡片里只到“分钟 / 小时 / 天”这一粒度，再细就是噪声。 */
export function timeAgo(ms: number, now: number): { amount: number; unit: "minute" | "hour" | "day" } {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  if (minutes < 60) return { amount: minutes, unit: "minute" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { amount: hours, unit: "hour" };
  return { amount: Math.floor(hours / 24), unit: "day" };
}

/**
 * 主页「资讯」卡片显示哪一个渠道。
 *
 * 默认取**列表里的第一个**——自定义订阅排在静态渠道前面，所以就是「我添加的第一个 RSS 源」。
 * 设置里选了具体渠道就用它；选的那个被删掉了就退回默认，而不是给一张空卡。
 */
export function pickHomeFeed<T extends { id: string }>(sources: readonly T[], preferred: string | null): T | undefined {
  if (preferred) {
    const found = sources.find(source => source.id === preferred);
    if (found) return found;
  }
  return sources[0];
}
