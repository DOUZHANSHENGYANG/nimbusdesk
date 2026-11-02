import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { useRef, type ReactNode } from "react";
import { cn } from "@/ahub/lib/utils";

gsap.registerPlugin(useGSAP);

export function PageShell({
  title,
  actions,
  tabs,
  children,
  className,
}: {
  title: string;
  actions?: ReactNode;
  /** 页签条：合并成一页的多个子页面共用（工具箱的技能 / 提示词 / MCP） */
  tabs?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      gsap.from("[data-anim]", {
        opacity: 0,
        y: 12,
        duration: 0.42,
        stagger: 0.05,
        ease: "power2.out",
        clearProps: "all",
      });
    },
    { scope },
  );

  return (
    <div ref={scope} className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {/* 页面头：刻意不加底板与分隔线 —— 现代桌面应用靠留白与字重分层，
          而不是给每条标题画一条横线（那会让界面更"网页报表"而不是工具） */}
      <div data-anim className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2.5 px-5 pb-3.5 pt-4 md:px-6 md:pt-5">
        {/* 有页签时标题让位：合并成一页之后，"技能"这种标题已经由页签表达，
            再写一遍是重复的信息，还白占一行高度 */}
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          {tabs ?? (
            <h1 className="truncate text-[20px] font-semibold leading-tight tracking-[-0.015em] text-foreground">
              {title}
            </h1>
          )}
        </div>
        {/* 页签与动作同处一行、从左到右排；一行放不下就整体换行接着排，
            既不去压页签，也不把最后几个按钮孤零零地甩到右边 */}
        {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 md:px-6">{children}</div>
    </div>
  );
}
