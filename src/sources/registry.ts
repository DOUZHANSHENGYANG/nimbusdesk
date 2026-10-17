/**
 * 渠道注册表 —— 扩展检阅渠道的唯一入口。
 * 加一个新渠道：① 在 sources/ 下新建文件实现 SourceAdapter（可调用 fetchRssEntries 或抓取/JSON API）
 *             ② 在下面 SOURCE_LIST 里注册一行。侧栏与调度自动生效，无需改 UI。
 */
import type { SourceAdapter } from "./types";
import { github } from "./hot/github";
import { hackernews } from "./hot/hackernews";
import { sspai } from "./hot/sspai";
import { zhihu } from "./hot/zhihu";
import { v2ex } from "./hot/v2ex";
import { solidot } from "./hot/solidot";

export const SOURCE_LIST: SourceAdapter[] = [
  github,
  hackernews,
  solidot,
  sspai,
  zhihu,
  v2ex,
];

export const SOURCE_MAP: Record<string, SourceAdapter> = Object.fromEntries(
  SOURCE_LIST.map((s) => [s.id, s]),
);

/** 侧栏分组顺序 */
export const GROUP_ORDER = ["技术", "资讯", "社区"];
