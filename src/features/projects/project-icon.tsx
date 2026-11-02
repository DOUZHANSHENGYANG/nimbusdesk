import { useEffect, useState } from "react";
import {
  BookOpen, Box, Boxes, Briefcase, Bug, Calendar, Camera, ChartColumn, ClipboardList, Cloud, CodeXml,
  Cpu, Database, FileText, Flame, FlaskConical, Folder, FolderKanban, Gamepad2, GitBranch, Globe,
  GraduationCap, Heart, Home, Layers, Lightbulb, Mail, Map as MapIcon, MessageSquare, Music, Package, Palette,
  PenTool, Rocket, Search, Server, Settings, Shield, ShoppingCart, Smartphone, Sparkles, Star, Target,
  Terminal, Truck, Users, Video, Wallet, Wrench, Zap, type LucideIcon,
} from "lucide-react";

/**
 * 项目图标。
 *
 * 分两层，为的是「能挑任意 lucide 图标」但**不把整套图标打进首包**：
 * - 常用白名单（下面 50 个）静态引入，是绝大多数项目的落点，也是首帧就有的那一层；
 * - 白名单外的名字走 `lucide-react/dynamic` 的**按需导入**（每个图标一个 chunk，
 *   加载后进模块级缓存）。`dynamicIconImports` 本体 126KB，只在那一步动态取，
 *   所以它不进入口闭包 —— `npm run check:bundle` 会盯着这条线。
 *
 * 名字存在数据里，因此两种写法都得认：老数据是 PascalCase（`Rocket`），
 * 选择器给的是 lucide 的 kebab（`rocket`）。
 */
export const PROJECT_ICONS: Record<string, LucideIcon> = {
  BookOpen, Box, Boxes, Briefcase, Bug, Calendar, Camera, ChartColumn, ClipboardList, Cloud, CodeXml,
  Cpu, Database, FileText, Flame, FlaskConical, Folder, FolderKanban, Gamepad2, GitBranch, Globe,
  GraduationCap, Heart, Home, Layers, Lightbulb, Mail, Map: MapIcon, MessageSquare, Music, Package, Palette,
  PenTool, Rocket, Search, Server, Settings, Shield, ShoppingCart, Smartphone, Sparkles, Star, Target,
  Terminal, Truck, Users, Video, Wallet, Wrench, Zap,
};
export const PROJECT_COLORS = [1, 2, 3, 4, 5] as const;

/** `CodeXml` → `code-xml`；已经是 kebab 的原样返回（数字前也断一下：`Printer3d` → `printer-3d`） */
export function toKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Za-z])(\d)/g, "$1-$2")
    .replace(/(\d)([A-Za-z])/g, "$1-$2")
    .toLowerCase();
}

/** `code-xml` → `CodeXml`（白名单按 PascalCase 存，用来先试静态那一层） */
export function toPascal(name: string): string {
  return name.split(/[-_\s]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join("");
}

/** 已加载的按需图标；同一图标在多处出现只加载一次 */
const lazyIcons = new Map<string, LucideIcon>();

/**
 * 解析一个图标名：白名单内同步拿，白名单外按需加载（加载中先回退 `Folder`，不闪空白）。
 * 名字非法或加载失败也回退 —— 一个坏名字不该让整行渲染不出来。
 */
export function useProjectIcon(name?: string | null): LucideIcon {
  const staticIcon = name ? PROJECT_ICONS[name] ?? PROJECT_ICONS[toPascal(name)] : undefined;
  const [lazy, setLazy] = useState<LucideIcon | null>(() => (name ? lazyIcons.get(toKebab(name)) ?? null : null));

  useEffect(() => {
    if (!name || staticIcon) return;
    const key = toKebab(name);
    const cached = lazyIcons.get(key);
    if (cached) { setLazy(() => cached); return; }
    let cancelled = false;
    void import("lucide-react/dynamic")
      .then((module) => {
        const load = (module.dynamicIconImports as Record<string, undefined | (() => Promise<{ default: LucideIcon }>)>)[key];
        return load ? load() : null;
      })
      .then((module) => {
        if (!module || cancelled) return;
        lazyIcons.set(key, module.default);
        setLazy(() => module.default);
      })
      .catch(() => undefined); // 名字不存在：保持回退图标
    return () => { cancelled = true; };
  }, [name, staticIcon]);

  return staticIcon ?? lazy ?? Folder;
}

export function ProjectGlyph({ icon, color, className = "size-4" }: { icon?: string | null; color?: number | null; className?: string }) {
  const Icon = useProjectIcon(icon);
  return <Icon className={className} style={color ? { color: `var(--chart-${color})` } : undefined} aria-hidden />;
}
export function randomProjectColor(): number {
  return PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)];
}
