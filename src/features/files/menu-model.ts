import type { LucideIcon } from "lucide-react";

/**
 * 菜单数据模型。
 *
 * 为什么用「树 + 字符串动作名」而不是直接把 React 节点/回调发给浮窗：
 * 浮窗是独立 WebView，函数无法跨窗口传递；而且浮窗不该读 store / i18n
 * （两个窗口水合时序不一致会出现菜单显示错数据）。
 * 所以由打开方构建好「已翻译的纯数据树」，浮窗只负责渲染并把动作名发回。
 */

/** 浮窗内可用的图标名（LucideIcon 不能跨窗口传，用名字映射） */
export type MenuIconKey =
  | "open"
  | "reveal"
  | "rename"
  | "copy"
  | "delete"
  | "newFolder"
  | "newFile"
  | "folder"
  | "text"
  | "sheet"
  | "code"
  | "image"
  | "archive"
  | "bindDir"
  | "unbindDir"
  | "root"
  | "fence"
  | "fenceOff"
  | "moveTo"
  | "category";

export interface MenuItemNode {
  kind: "item";
  /** 动作名，由打开方解释执行 */
  action: string;
  /** 动作附带的值（如新建的文件扩展名） */
  value?: string;
  label: string;
  icon?: MenuIconKey;
  shortcut?: string;
  disabled?: boolean;
  destructive?: boolean;
}

export interface MenuSepNode {
  kind: "sep";
}

export interface MenuSubNode {
  kind: "sub";
  label: string;
  icon?: MenuIconKey;
  items: MenuNode[];
}

export type MenuNode = MenuItemNode | MenuSepNode | MenuSubNode;

/** 图标名 → 组件（浮窗侧映射） */
export type IconMap = Record<MenuIconKey, LucideIcon>;

/** 条目上的标记：右键时据此判断命中了哪一条 */
export const ITEM_ATTR = "data-item-id";
