/** Solidot —— 科技新闻 RSS */
import type { SourceAdapter } from "../types";
import { fetchRssEntries } from "../rss";

export const solidot: SourceAdapter = {
  id: "solidot",
  name: "Solidot",
  group: "技术",
  homepage: "https://www.solidot.org",
  async fetch() {
    return fetchRssEntries("https://www.solidot.org/index.rss", 30);
  },
};
