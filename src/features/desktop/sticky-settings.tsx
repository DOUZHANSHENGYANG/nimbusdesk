import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { STICKY_LIMITS, stickyAppearance, stickyColor, type StickyAppearance, type StickyDimension } from "./sticky-presentation";

interface StickySettingsProps {
  value: StickyAppearance;
  onChange: (patch: Partial<StickyAppearance>) => void;
  en?: boolean;
  /** Position locks prevent resizing; color preferences remain editable. */
  disabled?: boolean;
  tabHeightLocked?: boolean;
  tabWidthLocked?: boolean;
}

function DimensionInput({ name, label, value, onChange, en, disabled }: {
  name: StickyDimension; label: string; value: number | undefined;
  onChange: StickySettingsProps["onChange"]; en: boolean; disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value?.toString() ?? "");
  useEffect(() => { setDraft(value?.toString() ?? ""); }, [value]);
  const { min, max } = STICKY_LIMITS[name];
  const commit = () => {
    const number = draft.trim() ? Number(draft) : undefined;
    if (number === undefined || Number.isFinite(number)) {
      onChange({ [name]: number });
      setDraft(number === undefined ? "" : String(Math.min(max, Math.max(min, Math.round(number)))));
    } else setDraft(value?.toString() ?? "");
  };
  return <label className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">
    {label}
    <Input type="number" inputMode="numeric" min={min} max={max} step={1} value={draft} disabled={disabled}
      aria-label={label} placeholder={en ? "Auto" : "自动"} className="h-8 bg-background text-foreground tabular-nums"
      onChange={event => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); event.currentTarget.blur(); } }} />
  </label>;
}

/** Compact popover contents. The host owns visibility and keeps the dock open. */
export function StickySettings({ value, onChange, en = false, disabled = false, tabHeightLocked = false, tabWidthLocked = false }: StickySettingsProps) {
  const normalized = stickyAppearance(value);
  const [hex, setHex] = useState(value.stickyColor ?? "");
  useEffect(() => { setHex(value.stickyColor ?? ""); }, [value.stickyColor]);
  const valid = !hex.trim() || !!stickyColor(hex);
  const commitColor = () => {
    if (valid) onChange({ stickyColor: hex.trim() ? stickyColor(hex) : undefined });
  };
  return <fieldset className="w-64 max-w-full space-y-4 border-0 p-0" aria-label={en ? "Sticky appearance" : "便签外观"}>
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium">{en ? "Sticky color" : "便签颜色"}</span>
        <Button type="button" variant="ghost" size="xs" onClick={() => { setHex(""); onChange({ stickyColor: undefined }); }}>{en ? "Default" : "恢复默认"}</Button>
      </div>
      <div className="flex items-center gap-2">
        <input type="color" value={normalized.stickyColor ?? "#20242b"} aria-label={en ? "Choose sticky color" : "选择便签颜色"}
          className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5 disabled:cursor-not-allowed"
          onChange={event => onChange({ stickyColor: event.target.value })} />
        <Input aria-label={en ? "Sticky color hex" : "便签颜色十六进制"} value={hex} spellCheck={false}
          maxLength={7} placeholder={en ? "Default / #RRGGBB" : "默认 / #RRGGBB"} aria-invalid={!valid}
          className="font-mono text-xs" onChange={event => setHex(event.target.value)} onBlur={commitColor}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); commitColor(); } }} />
      </div>
      {!valid && <p role="alert" className="text-[11px] text-destructive">{en ? "Use #RRGGBB, e.g. #4477AA" : "请输入 #RRGGBB，例如 #4477AA"}</p>}
    </div>
    <div className="space-y-2">
      <p className="text-xs font-medium">{en ? "Arrow size (px)" : "便签尺寸（像素）"}</p>
      <div className="grid grid-cols-2 gap-3">
        <DimensionInput name="tabWidth" label={en ? "Arrow width" : "便签长度"} value={normalized.tabWidth} onChange={onChange} en={en} disabled={disabled || tabWidthLocked} />
        <DimensionInput name="tabHeight" label={en ? "Arrow height" : "便签高度"} value={normalized.tabHeight} onChange={onChange} en={en} disabled={disabled || tabHeightLocked} />
      </div>
    </div>
    <div className="space-y-2">
      <p className="text-xs font-medium">{en ? "Expanded size (px)" : "展开窗口尺寸（像素）"}</p>
      <div className="grid grid-cols-2 gap-3">
        <DimensionInput name="previewWidth" label={en ? "Expanded width" : "展开宽度"} value={normalized.previewWidth} onChange={onChange} en={en} disabled={disabled} />
        <DimensionInput name="previewHeight" label={en ? "Expanded height" : "展开高度"} value={normalized.previewHeight} onChange={onChange} en={en} disabled={disabled} />
      </div>
    </div>
  </fieldset>;
}
