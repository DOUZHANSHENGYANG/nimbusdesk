import { Check, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/ahub/lib/utils";

/**
 * 技能选择器：输入即模糊过滤全局技能池，点击选中。
 * 用于依赖技能名称输入（避免手敲错名字）。
 */
export function SkillPicker({
  value,
  options,
  onSelect,
  placeholder,
  className,
  exclude,
}: {
  value: string;
  /** 可选技能名（全局池） */
  options: string[];
  onSelect: (name: string) => void;
  placeholder?: string;
  className?: string;
  /** 排除项（如自己） */
  exclude?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(value);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQ(value);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return options
      .filter((n) => n !== exclude)
      .filter((n) => !s || n.toLowerCase().includes(s))
      .slice(0, 50);
  }, [options, q, exclude]);

  return (
    <div ref={boxRef} className={cn("relative flex-1", className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-ink-3" />
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="h-7 w-full rounded-lg border border-input bg-surface pl-7 pr-2 font-mono text-xs text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-ink-3 focus:border-primary focus:shadow-[0_0_0_3px_var(--ah-primary-soft)]"
        />
      </div>
      {open ? (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-56 w-full min-w-52 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-xl">
          {filtered.length === 0 ? (
            <div className="px-2.5 py-2 text-[11px] text-ink-3">{t("skills.depNoMatch")}</div>
          ) : (
            filtered.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => {
                  onSelect(n);
                  setQ(n);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-xs outline-none transition-colors",
                  n === value ? "bg-primary-soft text-primary" : "text-ink-2 hover:bg-surface-2 hover:text-foreground",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{n}</span>
                {n === value ? <Check className="size-3 shrink-0" /> : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
