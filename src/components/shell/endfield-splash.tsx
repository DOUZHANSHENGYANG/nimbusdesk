import { useEffect, useState } from "react";

import { useSettings } from "@/stores/settings";

/**
 * 终末地开屏：测量网格 → 扫描光带 → 字标擦入 → 淡出（约 1.2 秒）。
 *
 * 三条约束，缺一条就会变成骚扰：
 * 1. 只在 `endfield` skin 下出现 —— 别的风格没有这个语汇；
 * 2. 每次启动只演一次（sessionStorage），切主题时才会重演；
 * 3. `prefers-reduced-motion` 下完全不挂载 —— 少一次等待比演得快更尊重这个设置。
 *
 * 点击或按键立即结束：这一层只是氛围，不该挡住任何操作。
 */
const SEEN_KEY = "nimbus.endfield-splash";

export function EndfieldSplash() {
  const visualStyle = useSettings((s) => s.visualStyle);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (visualStyle !== "endfield") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    try {
      if (sessionStorage.getItem(SEEN_KEY)) return;
      sessionStorage.setItem(SEEN_KEY, "1");
    } catch {
      return;
    }
    setOpen(true);
  }, [visualStyle]);

  useEffect(() => {
    if (!open) return;
    const done = () => setOpen(false);
    // CSS 自己也会在 1.25s 淡出；这里只负责把节点摘掉，别让它常驻在合成层里
    const timer = window.setTimeout(done, 1400);
    window.addEventListener("pointerdown", done, { once: true });
    window.addEventListener("keydown", done, { once: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", done);
      window.removeEventListener("keydown", done);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="ef-splash" aria-hidden>
      <span className="ef-splash__grid" />
      <span className="ef-splash__scan" />
      <span className="ef-splash__mark">
        Nimbus<span>云台</span>
      </span>
      <span className="ef-splash__band" />
    </div>
  );
}
