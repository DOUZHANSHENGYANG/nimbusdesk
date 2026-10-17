import { useRef } from "react";
import { Settings2, X, RotateCcw } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ToolsCopy } from "./copy";

export function PromptPreferences({ value, onChange, prompt, c }: {
  value: string; onChange: (value: string) => void; prompt: string; c: ToolsCopy;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  return <Popover>
    <PopoverTrigger asChild><button className="tool-preferences-trigger" data-custom={Boolean(value.trim())} aria-label={c.preferences}><Settings2 /><span>{c.preferences}</span>{value.trim() && <i aria-hidden="true" />}</button></PopoverTrigger>
    <PopoverContent className="tool-preferences-popover workbench-ui" align="end" sideOffset={10} collisionPadding={16} aria-label={c.preferences} onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus({ preventScroll: true }); }}>
      <div className="tool-prompt-heading"><h3>{c.preferences}</h3><PopoverPrimitive.Close asChild><button className="tool-icon-button" aria-label={c.closePreferences}><X /></button></PopoverPrimitive.Close></div>
      <p className="tool-prompt-description">{c.promptHint}</p>
      <label className="tool-pref-field"><span>{c.extra}</span><textarea ref={input} maxLength={4_000} value={value} onChange={(event) => onChange(event.target.value)} placeholder={c.extraHint} /></label>
      <div className="tool-pref-footer"><span>{value.length} / 4,000</span><button disabled={!value} onClick={() => onChange("")}><RotateCcw />{c.reset}</button></div>
      <details className="tool-system-prompt"><summary>{c.builtIn}</summary><pre>{prompt}</pre></details>
    </PopoverContent>
  </Popover>;
}
