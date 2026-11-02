import { useRef } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

/**
 * 侧栏导航的**呈现层**：分组、直达项、活跃药丸、折叠动画、右缘角标。
 *
 * 刻意不碰任何 store —— 首页侧栏与设置侧栏共用这一份，谁都不是特例：
 * 数据（分组 / 条目 / 角标）由调用方组装，交互（跳转 / 展开）由调用方接管。
 * 这样两处侧栏的观感不可能漂移，改一处两处同时生效。
 *
 * `skin` 只影响药丸的样式（Pogget 是「白纸片 + 内嵌底边」，玻璃层是品牌色淡底），
 * 其余行高、间距、圆角都由这里定死。
 */
export interface NavListEntry {
  /** 路由或页签 id；与 activeId 匹配即算选中 */
  to: string;
  label: string;
  icon: LucideIcon;
  /** 命中的额外路径（子路由合并成一个入口时用）；空则按 to 精确匹配 */
  match?: string[];
  /** 右缘角标：0 与 undefined 都留空位，保证右缘齐 */
  badge?: number;
}

export interface NavListGroup {
  key: string;
  label: string;
  icon: LucideIcon;
  /** 展示顺序即数组顺序；被调用方过滤掉的条目不在这里出现 */
  entries: NavListEntry[];
  /** 有值即直达：标题自己就是一条导航，点击跳转、不展开、没有箭头 */
  to?: string;
  /** 有值即「点标题去这里，箭头才展开」 */
  defaultTo?: string;
}

export interface NavListProps {
  groups: NavListGroup[];
  activeId: string;
  /** 分组展开态，键是 group.key */
  open: Record<string, boolean>;
  onToggle: (groupKey: string) => void;
  onSelect: (to: string) => void;
  collapsed: boolean;
  skin?: "nimbus" | "pogget" | "endfield";
  /** 条目展开时的展开按钮文案（无障碍用），由调用方翻译 */
  expandLabel: (label: string) => string;
  /** 底部插槽：数据目录、收起侧栏这类不属于导航的东西放这儿 */
  footer?: React.ReactNode;
}

/** 药丸的弹簧：滑得干脆、不来回晃。 */
const PILL_SPRING = { type: "spring", stiffness: 420, damping: 34 } as const;

export function NavList({
  groups,
  activeId,
  open,
  onToggle,
  onSelect,
  collapsed,
  skin = "nimbus",
  expandLabel,
  footer,
}: NavListProps) {
  const reduce = useReducedMotion();
  const listRef = useRef<HTMLDivElement>(null);
  const pogget = skin === "pogget";

  const hit = (entry: { to: string; match?: string[] }) =>
    entry.match ? entry.match.some((path) => activeId.startsWith(path)) : entry.to === activeId;

  const item = ({ to, label, icon: Icon, match, badge }: NavListEntry) => {
    const active = match ? match.some((path) => activeId.startsWith(path)) : activeId === to;
    return (
      <button
        key={to}
        type="button"
        data-active={active}
        onClick={() => onSelect(to)}
        title={label}
        className={cn(
          "app-nav-item relative flex h-[40px] shrink-0 items-center gap-3 rounded-[10px] px-2.5 text-[13.5px] font-medium transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)]",
          active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          pogget && "h-[42px] px-3 text-[14px]",
          collapsed && "justify-center px-0",
        )}
      >
        {active && <Pill pogget={pogget} />}
        <Icon
          className={cn("relative z-10 size-4 shrink-0 transition-colors duration-200", active ? "text-brand" : "opacity-70")}
          strokeWidth={active ? 2.1 : 1.6}
        />
        {!collapsed && <span className="relative z-10 truncate">{label}</span>}
        {/* 角标位每行都在（无数字时留空），这样右缘是齐的 */}
        {!collapsed && (
          <span
            className={cn(
              "relative z-10 ml-auto min-w-4 text-right text-[10.5px] tabular-nums",
              badge === undefined || badge === 0 ? "opacity-0" : active ? "text-brand" : "text-muted-foreground",
            )}
          >
            {badge ?? 0}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <motion.div
        ref={listRef}
        layoutRoot
        className="relative flex min-h-0 flex-col overflow-y-auto px-2 pt-3 pb-2"
      >
        {groups.map((group) => {
          if (!group.entries.length && !group.to) return null;
          const isOpen = Boolean(open[group.key]);
          const direct = group.to;
          const directActive = direct !== undefined && activeId === direct;
          // defaultTo：标题点击直接去那一页，箭头单独负责展开/收起
          const jumpTo = direct ?? group.defaultTo;
          const jumpActive = jumpTo !== undefined && activeId === jumpTo;
          // 目标页自己也参与高亮：删掉对应二级项之后只能靠它
          const groupActive =
            group.entries.some(hit) || (group.defaultTo !== undefined && activeId === group.defaultTo);
          return (
            <div key={group.key} className="relative flex flex-col gap-0.5">
              {/* 一级就是一条正常导航项（图标 + 标签 + 箭头），不是分区小标签：
                  一级字号 ≥ 二级，二级选中时一级也变色。 */}
              <button
                type="button"
                onClick={() => {
                  if (!jumpTo) {
                    onToggle(group.key);
                    return;
                  }
                  onSelect(jumpTo);
                  // 跳过去之后把这一组展开，用户能看到自己落在哪个子项上
                  if (!isOpen && !direct) onToggle(group.key);
                }}
                title={group.label}
                aria-expanded={direct || jumpTo ? undefined : isOpen}
                aria-current={directActive ? "page" : undefined}
                className={cn(
                  "relative flex h-[40px] w-full shrink-0 items-center gap-3 rounded-[10px] px-2.5 text-[14px] font-semibold transition-colors duration-200 hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)]",
                  jumpTo && !collapsed && "pr-9",
                  jumpActive || groupActive ? "text-brand" : "text-foreground/85 hover:text-foreground",
                  pogget && "h-[42px] px-3 text-[14.5px]",
                  collapsed && "justify-center px-0",
                )}
              >
                <group.icon className="size-4 shrink-0" strokeWidth={1.9} />
                {!collapsed && <span className="truncate">{group.label}</span>}
                {!collapsed && !direct && !jumpTo ? (
                  <ChevronRight
                    className={cn("ml-auto size-3.5 shrink-0 opacity-45 transition-transform duration-300", isOpen && "-rotate-90")}
                    strokeWidth={2.2}
                  />
                ) : null}
              </button>
              {!collapsed && !direct && jumpTo ? (
                <button
                  type="button"
                  onClick={() => onToggle(group.key)}
                  aria-expanded={isOpen}
                  aria-label={expandLabel(group.label)}
                  title={expandLabel(group.label)}
                  className={cn(
                    "absolute right-1 top-0 grid h-[40px] w-8 place-items-center rounded-md text-ink-3 opacity-60 transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                    pogget && "h-[42px]",
                  )}
                >
                  <ChevronRight
                    className={cn("size-3.5 transition-transform duration-300", isOpen && "-rotate-90")}
                    strokeWidth={2.2}
                  />
                </button>
              ) : null}
              {direct ? null : (
                <motion.div
                  initial={false}
                  animate={{ height: isOpen ? "auto" : 0, opacity: isOpen ? 1 : 0 }}
                  transition={reduce ? { duration: 0 } : PILL_SPRING}
                  className="flex flex-col gap-0.5 overflow-hidden"
                >
                  <div className={cn("flex flex-col gap-0.5", !collapsed && "pl-4")}>
                    {group.entries.map(item)}
                  </div>
                </motion.div>
              )}
            </div>
          );
        })}
      </motion.div>

      <div className="flex-1" />
      {footer}
    </div>
  );
}

/**
 * 活跃指示药丸。同一个侧栏里只有一个 `layoutId`，所以它会在条目之间滑动。
 * Pogget 风是「白纸片 + 内嵌底边」—— 不用品牌色铺底，品牌色只留给图标和操作。
 */
function Pill({ pogget }: { pogget?: boolean }) {
  return (
    <motion.span
      layoutId="nav-pill"
      transition={PILL_SPRING}
      aria-hidden
      className={cn(
        "absolute inset-0 rounded-[10px]",
        pogget
          ? "border border-border bg-card shadow-[inset_0_-1.5px_0_rgb(16_24_40/0.06),0_1px_2px_rgb(16_24_40/0.05)]"
          : "bg-[color-mix(in_srgb,var(--brand)_12%,transparent)]",
      )}
    />
  );
}
