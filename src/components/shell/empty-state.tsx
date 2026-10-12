import { useRef, type ReactNode } from "react";
import { gsap, useGSAP, EASE } from "@/lib/gsap";
import { cn } from "@/lib/utils";

/** 优雅空态：图标浮动动画 + 标题 + 提示 */
export function EmptyState({
  icon,
  title,
  hint,
  badge,
  className,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  badge?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      gsap.from(ref.current, {
        autoAlpha: 0,
        y: 18,
        duration: 0.5,
        ease: EASE.out,
      });
      gsap.to(iconRef.current, {
        y: -7,
        duration: 2.1,
        ease: "sine.inOut",
        yoyo: true,
        repeat: -1,
        delay: 0.4,
      });
    },
    { scope: ref },
  );

  return (
    <div
      ref={ref}
      className={cn(
        "flex h-full flex-col items-center justify-center gap-4 px-6 text-center",
        className,
      )}
    >
      <div
        ref={iconRef}
        className="relative grid size-20 place-items-center rounded-3xl border border-border bg-card text-brand shadow-[var(--pr-shadow-2)]"
      >
        <div className="absolute inset-0 rounded-3xl bg-gradient-to-b from-brand/8 to-transparent" />
        <span className="relative [&_svg]:size-9 [&_svg]:stroke-[1.6]">{icon}</span>
      </div>

      <div className="flex flex-col items-center gap-1.5">
        {badge && (
          <span className="rounded-full border border-brand/30 bg-brand/10 px-2.5 py-0.5 text-[11px] font-semibold tracking-wide text-brand-soft">
            {badge}
          </span>
        )}
        <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
        {hint && <p className="max-w-sm text-[13px] leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}
