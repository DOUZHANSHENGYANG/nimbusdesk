/**
 * 收纳盒外观参数 —— 对齐 Pogget `ContainerModel` 的展示字段。
 *
 * 这些值属于「盒子」本身（FileCategory.appearance），不是某个窗口的几何：
 * 文件页浮层、桌面栅栏、快速面板读同一份，改一次三处同步。
 * 归一化函数只放行已知值/范围，手改数据文件不会把界面写坏。
 */

export type BoxViewMode = "icons" | "list";
/** full = 完整文件名；noExt = 去扩展名；extOnly = 只显示扩展名；none = 不显示文字 */
export type BoxNameMode = "full" | "noExt" | "extOnly" | "none";
export type BoxTitleBar = "always" | "auto" | "hidden";
export type BoxFontFamily = "system" | "segoe" | "yahei" | "mono";

export interface BoxAppearance {
  view: BoxViewMode;
  /** 图标边长（逻辑像素） */
  iconSize: number;
  nameMode: BoxNameMode;
  /** 条目名字号（px） */
  fontSize: number;
  fontFamily: BoxFontFamily;
  /** `.txt` / `.md` 在图标位置显示正文缩略 */
  showTextPreview: boolean;
  /** 图片显示缩略图 */
  showMediaPreview: boolean;
  /** 栅栏标题栏：常显 / 悬停才显示 / 完全隐藏（保留顶部拖动条） */
  titleBar: BoxTitleBar;
  /** 卡片背景不透明度 0.5–1 */
  backgroundAlpha: number;
  /** 卡片圆角（px） */
  radius: number;
}

export const DEFAULT_BOX_APPEARANCE: BoxAppearance = {
  view: "icons",
  iconSize: 44,
  nameMode: "full",
  fontSize: 12,
  fontFamily: "system",
  showTextPreview: true,
  showMediaPreview: true,
  titleBar: "always",
  backgroundAlpha: 0.92,
  radius: 16,
};

const VIEWS: BoxViewMode[] = ["icons", "list"];
const NAME_MODES: BoxNameMode[] = ["full", "noExt", "extOnly", "none"];
const TITLE_BARS: BoxTitleBar[] = ["always", "auto", "hidden"];
const FONT_FAMILIES: BoxFontFamily[] = ["system", "segoe", "yahei", "mono"];

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value * 100) / 100));
}

/** 宽容读取：缺字段/坏字段回默认，合法值原样保留。 */
export function boxAppearance(value: unknown): BoxAppearance {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    view: VIEWS.includes(source.view as BoxViewMode) ? source.view as BoxViewMode : DEFAULT_BOX_APPEARANCE.view,
    iconSize: clampNumber(source.iconSize, 20, 72, DEFAULT_BOX_APPEARANCE.iconSize),
    nameMode: NAME_MODES.includes(source.nameMode as BoxNameMode) ? source.nameMode as BoxNameMode : DEFAULT_BOX_APPEARANCE.nameMode,
    fontSize: clampNumber(source.fontSize, 8, 18, DEFAULT_BOX_APPEARANCE.fontSize),
    fontFamily: FONT_FAMILIES.includes(source.fontFamily as BoxFontFamily) ? source.fontFamily as BoxFontFamily : DEFAULT_BOX_APPEARANCE.fontFamily,
    showTextPreview: typeof source.showTextPreview === "boolean" ? source.showTextPreview : DEFAULT_BOX_APPEARANCE.showTextPreview,
    showMediaPreview: typeof source.showMediaPreview === "boolean" ? source.showMediaPreview : DEFAULT_BOX_APPEARANCE.showMediaPreview,
    titleBar: TITLE_BARS.includes(source.titleBar as BoxTitleBar) ? source.titleBar as BoxTitleBar : DEFAULT_BOX_APPEARANCE.titleBar,
    backgroundAlpha: clampNumber(source.backgroundAlpha, 0.45, 1, DEFAULT_BOX_APPEARANCE.backgroundAlpha),
    radius: clampNumber(source.radius, 0, 28, DEFAULT_BOX_APPEARANCE.radius),
  };
}

/** 只接受合法字段的增量更新；显式 undefined 表示恢复默认值。 */
export function boxAppearancePatch(value: unknown): Partial<BoxAppearance> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const patch: Partial<BoxAppearance> = {};
  for (const key of Object.keys(DEFAULT_BOX_APPEARANCE) as (keyof BoxAppearance)[]) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    if (source[key] === undefined) {
      (patch as Record<string, unknown>)[key] = DEFAULT_BOX_APPEARANCE[key];
      continue;
    }
    const next = boxAppearance({ ...DEFAULT_BOX_APPEARANCE, [key]: source[key] })[key];
    (patch as Record<string, unknown>)[key] = next;
  }
  return patch;
}

/** CSS font-family 值；system 空串让调用方继承应用字体。 */
export function boxFontFamily(value: BoxFontFamily): string {
  switch (value) {
    case "segoe": return '"Segoe UI Variable Text", "Segoe UI", sans-serif';
    case "yahei": return '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
    case "mono": return '"Cascadia Mono", Consolas, monospace';
    default: return "";
  }
}

/** 名字显示：与 fence 的 fileNameMode 保持同一套规则。 */
export function boxDisplayName(name: string, mode: BoxNameMode): string {
  if (mode === "none") return "";
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0 && dot < name.length - 1;
  if (mode === "full" || !hasExt) return name;
  if (mode === "noExt") return name.slice(0, dot);
  return name.slice(dot + 1);
}
