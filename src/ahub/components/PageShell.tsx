import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { useRef, type ReactNode } from "react";
import { cn } from "@/ahub/lib/utils";

gsap.registerPlugin(useGSAP);

export function PageShell({
  title,
  actions,
  children,
  className,
}: {
  title: string;
  actions?: ReactNode;
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
      <div data-anim className="flex shrink-0 items-start justify-between gap-4 px-5 pb-3.5 pt-4 md:px-6 md:pt-5">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.015em] text-foreground">
            {title}
          </h1>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2 pt-0.5">{actions}</div> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 md:px-6">{children}</div>
    </div>
  );
}
