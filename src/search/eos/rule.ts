/**
 * 奇妙搜索源（EOS）规则表 —— 内置快照 + 运行时健康度。
 *
 * 规则来自 https://github.com/OrO-c/EveOneSearch 的订阅文件（`<JSON>…</JSON>` 包裹）。
 * 每条规则只是一个 **URL 模板**：把 `{keyword}` 换成关键词，打开那个站点的搜索页。
 * 所以这里做的是"把页面里的结果链接抽出来"，不是调 API。
 *
 * 健康度是这套东西能长期用的关键：站点会改版、会挂、会上反爬。
 * 失败累计到阈值就进冷却，冷却期内不再参与搜索；成功一次就清零。
 * 于是「搜索失败自动失效」不需要人工维护白名单。
 */
import bundle from "./rules.json";

export interface EosRule {
  /** 上游 ruleID，稳定标识 */
  id: string;
  title: string;
  /** 上游分组（软件 / 网盘 / 磁力 …），用于结果徽标 */
  group: string;
  /** 含 `{keyword}` 的 URL 模板 */
  url: string;
  /** 内置快照里记录的实测命中数，只用于首次排序 */
  yield: number;
  ua?: string;
  referer?: string;
}

export interface EosBundle {
  source: string;
  upstreamVersion: number;
  upstreamUpdatedAt: number;
  bundledAt: number;
  rules: EosRule[];
}

export const EOS_BUNDLE = bundle as EosBundle;
export const EOS_RULES: EosRule[] = EOS_BUNDLE.rules;

/**
 * 只在"输入一个域名"时才成立的规则（备案查询、拦截检测这类站长工具）。
 * 作为通用搜索源它们永远返回噪音 —— 搜 `react` 会给出"react 的 ICP 备案信息"。
 * 保留在快照里（用户可能想查），但不参与 searchWeb。
 */
const DOMAIN_ONLY = new Set(["站长工具"]);

export const SEARCHABLE_RULES: EosRule[] = EOS_RULES.filter((rule) => !DOMAIN_ONLY.has(rule.group));

/** 关键词替换。`{keyword}` 也可能出现在 JSON 数组参数里，编码必须逐段做。 */
export function buildEosUrl(rule: EosRule, keyword: string): string {
  return rule.url.replace(/\{keyword\}/g, encodeURIComponent(keyword));
}
