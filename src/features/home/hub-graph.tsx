import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { DUR, EASE, gsap, useGSAP } from "@/lib/gsap";
import { RollingNumber } from "@/components/motion/rolling-number";
import { cn } from "@/lib/utils";
import type { HomeRelations, RelationKind } from "@/features/home/relations";

/** 卫星强调色：只用 tokens.css 里已有的语义色，不引入新的色相（check-contrast 只认 tokens.css） */
export type HubAccent = "brand" | "info" | "success" | "warning";

export interface HubNode {
  id: string;
  icon: ReactNode;
  label: string;
  value: number;
  accent: HubAccent;
  onClick: () => void;
}

/*
 * 舞台是一个 100×100 的 viewBox，节点与连线端点共用同一套百分比坐标 ——
 * 于是改窗口宽度不需要任何测量：非等比缩放下直线仍是直线，线宽由
 * vectorEffect="non-scaling-stroke" 兜住（否则横线会被拉得比竖线粗）。
 *
 * 卫星左二右二；连线终点收进卫星卡片之下（终点 x 在卡片内侧边缘之后，
 * 于是线看起来「插进」卡片，而不是停在半空）。
 */
const SLOTS = [
  { x: 17, y: 24 },
  { x: 17, y: 76 },
  { x: 83, y: 24 },
  { x: 83, y: 76 },
] as const;

const LINE_ENDS = [
  { x: 27, y: 35 },
  { x: 27, y: 65 },
  { x: 73, y: 35 },
  { x: 73, y: 65 },
] as const;

/**
 * 两颗卫星之间的弧：控制点从中点朝「远离中枢」的方向推出去。
 * 弧顶（二次贝塞尔中点 = 0.25A + 0.5C + 0.25B）就是计数徽标的落点。
 * 控制点夹在 [4,96] 里 —— 否则弧会顶出 viewBox，被 svg 视口裁掉半截。
 */
function arcBetween(a: { x: number; y: number }, b: { x: number; y: number }) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const ox = mx - 50;
  const oy = my - 50;
  const len = Math.hypot(ox, oy) || 1;
  const clamp = (v: number) => Math.min(96, Math.max(4, v));
  const cx = clamp(mx + (ox / len) * 16);
  const cy = clamp(my + (oy / len) * 16);
  return {
    d: `M ${a.x} ${a.y} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x} ${b.y}`,
    badge: { x: 0.25 * a.x + 0.5 * cx + 0.25 * b.x, y: 0.25 * a.y + 0.5 * cy + 0.25 * b.y },
  };
}

const ACCENT_CHIP: Record<HubAccent, string> = {
  brand: "bg-brand/10 text-brand",
  info: "bg-info/10 text-info",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
};

/*
 * 连线的颜色编码放在线上，不放「端点圆点」：舞台是非等比拉伸的，
 * viewBox 里的圆会被压成椭圆；而用固定像素的 HTML 圆点又算不准
 * —— 卡片宽 184px 固定、舞台宽度按百分比变，两者对不上。
 */
const ACCENT_LINE: Record<HubAccent, string> = {
  brand: "stroke-brand/40",
  info: "stroke-info/40",
  success: "stroke-success/40",
  warning: "stroke-warning/40",
};

/** 中枢圆环几何：viewBox 与半径固定，圆周用于 strokeDasharray */
const RING_VB = 112;
const RING_R = 48;
const RING_C = 2 * Math.PI * RING_R;

/**
 * 今日脉络：一个中枢（今日完成度）+ 若干卫星（统计口径），细线相连。
 *
 * 注意线的含义是**归属**而不是数据推导：每个统计口径都挂在「今天」这根中枢上。
 * 要画真实关系（计划→关联文件、收藏→来源、文件→分类）需要另加一层推导。
 */
export function HubGraph({
  nodes,
  done,
  total,
  relations,
  onHubClick,
}: {
  nodes: HubNode[];
  done: number;
  total: number;
  relations: HomeRelations;
  onHubClick: () => void;
}) {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const ratio = total > 0 ? Math.min(done / total, 1) : 0;

  /** 悬停/聚焦的卫星下标：用来把与它无关的连线压暗 */
  const [active, setActive] = useState<number | null>(null);
  const arcs = relations.edges.map((edge) => ({
    edge,
    ...arcBetween(SLOTS[edge.from] ?? SLOTS[0], SLOTS[edge.to] ?? SLOTS[0]),
  }));
  const edgeLabel = (kind: RelationKind) =>
    kind === "plans-items" ? t("home.relPlansItems") : t("home.relItemsFences");
  const { uncategorized, unlinkedTasks } = relations.orphans;

  /* 只报非零的那部分：写「未分类条目 0」是噪音 */
  const orphanParts: string[] = [];
  if (uncategorized > 0) orphanParts.push(t("home.orphanItems", { count: uncategorized }));
  if (unlinkedTasks > 0) orphanParts.push(t("home.orphanTasks", { count: unlinkedTasks }));

  /*
   * 依赖用「关联签名」而不是 relations 对象：对象每次渲染都是新引用，
   * 直接放进依赖数组会让进场动画每次重渲染都重放一遍。
   */
  const edgeSig = relations.edges.map((e) => `${e.kind}:${e.count}`).join(",");
  /** 与当前悬停的卫星之间存在真实关联的卫星 */
  const tiedTo = (i: number) =>
    active !== null &&
    relations.edges.some(
      (e) => (e.from === active && e.to === i) || (e.to === active && e.from === i),
    );

  useGSAP(
    () => {
      const stage = stageRef.current;
      if (!stage) return;

      const lines = Array.from(stage.querySelectorAll<SVGPathElement>("[data-hub-line]"));
      const ring = stage.querySelector<SVGCircleElement>("[data-hub-ring]");
      const rels = Array.from(stage.querySelectorAll<SVGPathElement>("[data-hub-rel]"));

      // 减少动效：不做「描线生长」，连线与圆环直接呈现终态
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

      for (const line of lines) {
        const len = line.getTotalLength();
        gsap.set(line, { strokeDasharray: len, strokeDashoffset: len });
      }
      gsap.to(lines, {
        strokeDashoffset: 0,
        duration: DUR.slow,
        ease: EASE.out,
        stagger: 0.07,
        delay: 0.08,
        clearProps: "strokeDasharray,strokeDashoffset",
      });
      for (const rel of rels) {
        const len = rel.getTotalLength();
        gsap.set(rel, { strokeDasharray: len, strokeDashoffset: len });
      }
      gsap.to(rels, {
        strokeDashoffset: 0,
        duration: DUR.slow,
        ease: EASE.out,
        stagger: 0.09,
        delay: 0.18,
        clearProps: "strokeDasharray,strokeDashoffset",
      });
      if (ring) {
        gsap.fromTo(
          ring,
          { strokeDasharray: `0 ${RING_C}` },
          {
            strokeDasharray: `${ratio * RING_C} ${RING_C}`,
            duration: 0.72,
            ease: EASE.out,
            delay: 0.1,
          },
        );
      }
    },
    { scope: stageRef, dependencies: [ratio, edgeSig] },
  );

  return (
    <section
      data-dash-card
      aria-label={t("home.hubTitle")}
      className="rounded-2xl border border-border bg-card p-4 shadow-[var(--pr-shadow-1)]"
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-semibold text-foreground/90">{t("home.hubTitle")}</h3>
        <span className="truncate text-[12px] text-muted-foreground">{t("home.hubHint")}</span>
      </div>

      <div ref={stageRef} className="relative h-[212px]">
        <svg
          className="pointer-events-none absolute inset-0 size-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {nodes.map((node, i) => {
            const end = LINE_ENDS[i] ?? LINE_ENDS[0];
            const bend = end.y < 50 ? -7 : 7;
            return (
              <g key={node.id}>
                <path
                  data-hub-line
                  d={`M 50 50 Q ${(50 + end.x) / 2} ${(50 + end.y) / 2 + bend} ${end.x} ${end.y}`}
                  fill="none"
                  strokeWidth={1.25}
                  vectorEffect="non-scaling-stroke"
                  className={ACCENT_LINE[node.accent]}
                />
              </g>
            );
          })}
          {/* 真实关联：模块之间数据上真有关系才画的粗线（归属细线是上面那组） */}
          {arcs.map(({ edge, d }) => (
            <path
              key={edge.kind}
              data-hub-rel
              d={d}
              fill="none"
              strokeWidth={2}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              className={cn(
                "stroke-brand/45 transition-opacity duration-200",
                active !== null && active !== edge.from && active !== edge.to && "opacity-20",
              )}
            />
          ))}
        </svg>

        {/* 关联计数：只画在真有关系的两颗卫星之间，位置是弧顶 */}
        {arcs.map(({ edge, badge }) => (
          <span
            key={edge.kind}
            style={{ left: `${badge.x}%`, top: `${badge.y}%` }}
            title={`${edgeLabel(edge.kind)} ${edge.count}${
              edge.samples.length > 0 ? ` · ${edge.samples.join("、")}` : ""
            }`}
            className={cn(
              "absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-brand/40 bg-background px-1.5 py-px text-[11px] font-semibold tabular-nums text-brand shadow-[var(--pr-shadow-1)] transition-opacity duration-200",
              active !== null && active !== edge.from && active !== edge.to && "opacity-30",
            )}
          >
            {edge.count}
          </span>
        ))}

        {/* 中枢：今日完成度。与「今日计划」卫星同去计划页 */}
        <button
          type="button"
          onClick={onHubClick}
          aria-label={`${t("home.hubDone")} ${done}/${total} · ${t("home.goToPlans")}`}
          className="absolute left-1/2 top-1/2 grid size-28 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-border bg-background shadow-[var(--pr-shadow-2)] transition-transform duration-150 hover:scale-[1.03]"
        >
          <svg
            className="absolute inset-0 size-full -rotate-90"
            viewBox={`0 0 ${RING_VB} ${RING_VB}`}
            aria-hidden="true"
          >
            <circle
              cx={RING_VB / 2}
              cy={RING_VB / 2}
              r={RING_R}
              fill="none"
              strokeWidth={4}
              className="stroke-border"
            />
            <circle
              data-hub-ring
              cx={RING_VB / 2}
              cy={RING_VB / 2}
              r={RING_R}
              fill="none"
              strokeWidth={4}
              strokeLinecap="round"
              strokeDasharray={`${ratio * RING_C} ${RING_C}`}
              className="stroke-brand"
            />
          </svg>
          <span className="flex flex-col items-center leading-none">
            <RollingNumber
              value={done}
              duration={0.9}
              className="text-[24px] font-bold tracking-tight tabular-nums"
            />
            <span className="mt-1 text-[11px] tabular-nums text-muted-foreground">
              / <RollingNumber value={total} duration={0.9} />
            </span>
            <span className="mt-1.5 text-[11px] text-muted-foreground">{t("home.hubDone")}</span>
          </span>
        </button>

        {nodes.map((node, i) => {
          const slot = SLOTS[i] ?? SLOTS[0];
          return (
            <button
              key={node.id}
              type="button"
              onClick={node.onClick}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive((cur) => (cur === i ? null : cur))}
              onFocus={() => setActive(i)}
              onBlur={() => setActive((cur) => (cur === i ? null : cur))}
              style={{ left: `${slot.x}%`, top: `${slot.y}%` }}
              className={cn(
                "absolute flex w-[184px] -translate-x-1/2 -translate-y-1/2 items-center gap-2.5 rounded-xl border border-border bg-background px-3 py-2.5 text-left transition-all duration-150 hover:border-brand/40 hover:bg-muted",
                tiedTo(i) && "border-brand/60 shadow-[var(--pr-shadow-glow)]",
                active !== null && active !== i && !tiedTo(i) && "opacity-45",
              )}
            >
              <span
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-lg",
                  ACCENT_CHIP[node.accent],
                )}
              >
                {node.icon}
              </span>
              <span className="flex min-w-0 flex-col leading-none">
                <RollingNumber
                  value={node.value}
                  className="text-[20px] font-bold tracking-tight tabular-nums"
                />
                <span className="mt-1 truncate text-[12px] text-muted-foreground">
                  {node.label}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {(arcs.length > 0 || orphanParts.length > 0) && (
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          {arcs.length > 0 && <span>{t("home.relHint")}</span>}
          {orphanParts.length > 0 && <span>{orphanParts.join(" · ")}</span>}
        </p>
      )}
    </section>
  );
}
