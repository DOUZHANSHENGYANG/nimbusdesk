/**
 * 农历 / 节气 / 节日。
 *
 * 为什么单独包一层：日历只想知道「这一天在中文日历上叫什么」，而
 * lunar-typescript 的 API 面很大（八字、宜忌、神煞、黄道）。这里收口成一个纯函数，
 * 视图不必认识那个库，将来换实现也只改这一处。
 *
 * 刻意只做**只读展示**：不参与任何落盘，所以不影响备份格式。
 */
import { Solar } from "lunar-typescript";

export type LunarKind = "festival" | "term" | "date";

export interface LunarLabel {
  /** 显示文本，2–3 个字 */
  text: string;
  /** festival=节日 · term=节气 · date=普通农历日（渲染时区分深浅） */
  kind: LunarKind;
}

/** 一天只算一次：年视图一次要问 504 天，月视图 42 天。键是 YYYY-MM-DD，量级一年几百条 */
const cache = new Map<string, LunarLabel | null>();

/**
 * 这一天的农历标签，按中文日历的惯例排优先级：
 * 节日（公历 + 农历）> 节气 > 农历初一（显示月名）> 农历日。
 *
 * 这套名字本身是中文的，英文界面下调用方不渲染（见 shared.tsx 的 `LunarText`）。
 * 「法定节假日 / 调休」不在这里：那是每年公布的安排，不是历法推算。
 */
export function lunarLabel(date: string): LunarLabel | null {
  const hit = cache.get(date);
  if (hit !== undefined) return hit;
  const label = compute(date);
  cache.set(date, label);
  return label;
}

function compute(date: string): LunarLabel | null {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return null;
  const solar = Solar.fromYmd(year, month, day);
  const lunar = solar.getLunar();
  // 公历节日在前：元旦/劳动节/国庆这类大家按公历记，农历那边的除夕/中秋同名日子不会重
  const festival = solar.getFestivals()[0] ?? lunar.getFestivals()[0];
  if (festival) return { text: festival, kind: "festival" };
  const term = lunar.getJieQi();
  if (term) return { text: term, kind: "term" };
  if (lunar.getDay() === 1) return { text: `${lunar.getMonthInChinese()}月`, kind: "date" };
  return { text: lunar.getDayInChinese(), kind: "date" };
}
