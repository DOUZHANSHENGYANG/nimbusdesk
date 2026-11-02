import { useMemo, useRef, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { gsap, useGSAP, DUR, EASE } from "@/lib/gsap";

/**
 * 路由 → 眉标段（英文小标签不翻译，永远宽体大写）。只被 endfield 消费。
 */
function routeSection(pathname: string): string {
  if (pathname === "/") return "HOME";
  if (pathname.startsWith("/projects") || pathname.startsWith("/plans") || pathname.startsWith("/github")) return "PROJECTS";
  if (pathname.startsWith("/ai") || pathname.startsWith("/toolbox") || pathname.startsWith("/agent")) return "AI";
  if (pathname.startsWith("/tools") || pathname.startsWith("/canvas")) return "TOOLS";
  if (pathname.startsWith("/settings")) return "SETTINGS";
  return "WORKBENCH";
}

/**
 * 路由切换过渡：淡入 + 上浮。
 *
 * 只在这一个入口做，页面自己不需要知道当前是哪套风格 —— 也就**只有一套语言**。
 * 曾在终末地皮肤下换成 `clip-path` 快门（内容从上往下擦出来），用户明确不要：
 * 切个侧栏就被整页擦一遍太吵，机械感不该由「每次都重放一遍」来表现。
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  const ref = useRef<HTMLDivElement>(null);
  const section = routeSection(location.pathname);
  const today = useMemo(
    () => new Date().toISOString().slice(0, 10).replaceAll("-", "."),
    [],
  );

  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;

      gsap.fromTo(
        el,
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
      {/* 频道条：// SECTION + 日期。只在 endfield 下出现，其它 skin 里是 display:none，
          不占高度也不挤任何页面 */}
      <div className="ef-eyebrow" aria-hidden>
        <span>// {section}</span>
        <span>{today}</span>
      </div>
      {children}
    </div>
  );
}
