import { useEffect, useRef, useState } from "react";

import { useSettings } from "@/stores/settings";
import { cn } from "@/lib/utils";

/**
 * 读数落定：数字打开时先乱跳，再从左到右逐位锁死（600ms，linear）。
 *
 * 三条限制，少一条就会变成噪音：
 * 1. 只在 endfield skin 下演 —— 其它风格是安静的产品界面，不需要仪表味；
 * 2. **只在首次挂载演一次**。数值后来变化直接显示，不然实时读数会一直抖；
 * 3. `prefers-reduced-motion` 下直接给最终值。
 *
 * 非数字字符（`%`、`,`、`.`、`/`）自始至终不动，随机只发生在 0-9 上。
 */
const DURATION = 600;
const DIGITS = "0123456789";

function randomDigits(target: string): string {
  let out = "";
  for (const ch of target) out += /\d/.test(ch) ? DIGITS[Math.floor(Math.random() * DIGITS.length)] : ch;
  return out;
}

function canScramble(): boolean {
  if (typeof window === "undefined") return false;
  if (useSettings.getState().visualStyle !== "endfield") return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function ScrambleNumber({ value, className }: { value: number | string; className?: string }) {
  const target = String(value);
  const [text, setText] = useState(() => (canScramble() ? randomDigits(target) : target));
  const mounted = useRef(false);

  useEffect(() => {
    if (mounted.current) {
      // 之后的数值变化不重演，否则每次刷新都在跳
      setText(target);
      return;
    }
    mounted.current = true;
    if (!canScramble() || !/\d/.test(target)) {
      setText(target);
      return;
    }

    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / DURATION);
      const locked = Math.floor(p * target.length);
      let out = "";
      for (let i = 0; i < target.length; i += 1) {
        const ch = target[i];
        out += i < locked || !/\d/.test(ch) ? ch : DIGITS[Math.floor(Math.random() * DIGITS.length)];
      }
      setText(out);
      if (p < 1) raf = requestAnimationFrame(tick);
      else setText(target);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return <span className={cn("tabular-nums", className)}>{text}</span>;
}
