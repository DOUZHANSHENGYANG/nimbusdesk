import { useRef, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { gsap, useGSAP, DUR, EASE } from "@/lib/gsap";

/** 路由切换 GSAP 过渡：淡入 + 上浮 + 微模糊 */
export function PageTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  const ref = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      gsap.fromTo(
        ref.current,
        { autoAlpha: 0, y: 14, filter: "blur(6px)" },
        {
          autoAlpha: 1,
          y: 0,
          filter: "blur(0px)",
          duration: DUR.slow,
          ease: EASE.out,
          clearProps: "filter,will-change",
        },
      );
    },
    { dependencies: [location.pathname], scope: ref },
  );

  return (
    <div ref={ref} className="flex h-full min-h-0 min-w-0 flex-col">
      {children}
    </div>
  );
}
