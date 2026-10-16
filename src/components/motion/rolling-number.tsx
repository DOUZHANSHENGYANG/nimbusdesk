import { useRef } from "react";
import { EASE, gsap, useGSAP } from "@/lib/gsap";

/**
 * 数字滚动：从 0 数到目标值。
 *
 * 为什么值得抽成一个公共组件（而不是各处写一遍 GSAP 代理）：
 *   「数据要动起来」这条要求会落到所有展示数字的地方 —— 首页中枢、统计卡、
 *   环形中心的百分比、图例计数。每处各写一遍的后果不是代码重复，而是**手感不一致**：
 *   时长/缓动/取整方式稍有差异，用户就会觉得「有的数字在滚、有的是啪一下跳出来」。
 *   统一在这里，改一处全体统一。
 *
 * 行为约定：
 *   - `value` 是 number → 从 0 滚到它；值变化时重新滚（不是从上次的值继续，
 *     因为「从 3 滚到 5」和「从 0 滚到 5」在扫视时后者更容易读清新值）
 *   - `value` 是 string（例如没有数据时的「—」）→ 直接呈现，不做动画。
 *     让「—」也参与滚动是没意义的，它没有量级。
 *   - 尊重 `prefers-reduced-motion`：直接落终值，不做任何过渡
 *
 * 用 `useGSAP`（内部是 layout effect）而不是 useEffect：动画在**绘制前**就开始，
 * 于是首帧渲染出来的就已经是动画起点，不会先闪一下未动的初始值。
 */
export function RollingNumber({
  value,
  className,
  suffix = "",
  duration = 0.7,
}: {
  value: number | string;
  className?: string;
  /** 数字后缀，如 "%" —— 与数字同处一个文本节点，避免号位分离导致跳动 */
  suffix?: string;
  /** 覆盖时长（秒）。默认 0.7s，与首页卫星一致 */
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const animated = typeof value === "number" && Number.isFinite(value);

  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;

      // 非数字（"—" 之类）没有量级，不做动画
      if (!animated) {
        el.textContent = String(value);
        return;
      }
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        el.textContent = `${value}${suffix}`;
        return;
      }

      const proxy = { v: 0 };
      const tween = gsap.to(proxy, {
        v: value,
        duration,
        ease: EASE.out,
        onUpdate: () => {
          el.textContent = `${Math.round(proxy.v)}${suffix}`;
        },
        // 结束时写精确值：Math.round 在边界上可能停在 n-1，
        // 而「显示 4 但数据是 5」是那种没人会报、但会一直存在的错
        onComplete: () => {
          el.textContent = `${value}${suffix}`;
        },
      });
      return () => tween.kill();
    },
    { dependencies: [value, suffix, animated, duration] },
  );

  return (
    <span ref={ref} className={className}>
      {animated ? `0${suffix}` : String(value)}
    </span>
  );
}
