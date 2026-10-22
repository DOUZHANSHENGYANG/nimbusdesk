import { AnimatePresence, motion } from "motion/react";
import { Moon, Sun } from "lucide-react";
import { useSettings } from "@/ahub/stores/settings";
import { cn } from "@/ahub/lib/utils";

/**
 * 主题切换按钮：
 * - 明→暗：以点击点为圆心，暗色圆形辐射扩散
 * - 暗→明：暗色层反向收拢回点击点
 * （View Transitions 实现，见 globals.css 的 [data-vt] 规则）
 */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={(e) => {
        const next = isDark ? "light" : "dark";
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        void setTheme(next, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
      }}
      className={cn(
        "grid size-8 place-items-center rounded-lg text-ink-2 outline-none transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={theme}
          initial={{ rotate: -70, opacity: 0, scale: 0.6 }}
          animate={{ rotate: 0, opacity: 1, scale: 1 }}
          exit={{ rotate: 70, opacity: 0, scale: 0.6 }}
          transition={{ type: "spring", stiffness: 320, damping: 26 }}
          className="grid place-items-center"
        >
          {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
