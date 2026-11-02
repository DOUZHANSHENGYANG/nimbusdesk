import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PROJECT_ICONS, ProjectGlyph, randomProjectColor } from "./project-icon";

/**
 * 图标选择器：**直接点**，不搜索。
 *
 * 用户明确要「点图标就行，不选颜色、颜色随机生成」——所以这里只有一屏常用图标：
 * 点哪个就把 `icon` 写进去，并**随机配一个 token 色**（颜色不单独选，避免又多一步决策）。
 * 要恢复默认就点右上角的叉（图标回文件夹、颜色保持）。
 *
 * 为什么不做「搜索任意 lucide 图标」：他试过之后说不需要；全量搜索要按需加载 2100 个图标
 * 的映射表（每个图标一个 chunk），为一个不用的入口留着这套机制不值当。
 * 但**存进去的名字仍可能是任意 lucide 名字**（历史数据、以后换入口），
 * 所以绘制层 `useProjectIcon` 保留了按需解析的兜底，这里不重复实现。
 */
export function IconPicker({ value, color, en, onPick }: {
  value?: string | null;
  color?: number | null;
  en: boolean;
  /** icon 为 null 表示「恢复默认（文件夹）」；带上一起写的颜色 */
  onPick: (icon: string | null, color?: number) => void;
}) {
  const pick = (icon: string) => onPick(icon, randomProjectColor());
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {Object.keys(PROJECT_ICONS).map((key) => (
          <button key={key} type="button" aria-label={key} aria-pressed={value === key} title={key} onClick={() => pick(key)}
            className={cn("flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground", value === key && "bg-accent text-accent-foreground")}>
            <ProjectGlyph icon={key} color={value === key ? color : null} />
          </button>
        ))}
        {value ? (
          <button type="button" className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" title={en ? "Use the default folder" : "恢复默认图标"} aria-label={en ? "Use the default folder" : "恢复默认图标"} onClick={() => onPick(null, color ?? undefined)}>
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
