import { useTranslation } from "react-i18next";
import { RotateCcw, X } from "lucide-react";
import { type FileCategory } from "@/stores/files";
import { cn } from "@/lib/utils";
import { boxAppearance, DEFAULT_BOX_APPEARANCE, type BoxAppearance, type BoxFontFamily } from "./box-appearance";

type SegmentedOption<T extends string> = { value: T; label: string };

function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md border px-2 py-1 text-[11px] transition-colors",
            value === option.value
              ? "border-brand bg-brand/10 text-brand"
              : "border-border bg-card text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, children, value }: { label: string; children: React.ReactNode; value?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-foreground/80">{label}</span>
        {value && <span className="text-[10px] tabular-nums text-muted-foreground">{value}</span>}
      </div>
      {children}
    </div>
  );
}

/**
 * 每个收纳盒的外观设置。值写在 FileCategory.appearance 上，
 * 文件页浮层、桌面栅栏、快速面板共用；关闭即保存（没有独立“应用”按钮）。
 */
export const GROUP_COLORS = ["#b7e1b0", "#f5d48a", "#c9b7f5", "#aecdf5", "#f5b7d0"] as const;

export function BoxAppearancePanel({
  category,
  onChange,
  onClose,
  onGroupColor,
  onMerge,
  className,
}: {
  category: FileCategory;
  onChange: (patch: Partial<BoxAppearance>) => void;
  onClose: () => void;
  onGroupColor?: (color: string | undefined) => void;
  onMerge?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const a = boxAppearance(category.appearance);
  const set = <K extends keyof BoxAppearance>(key: K, value: BoxAppearance[K]) => onChange({ [key]: value } as Partial<BoxAppearance>);

  return (
    <div
      data-box-appearance
      role="dialog"
      aria-label="Box appearance"
      className={cn("flex max-h-[calc(100dvh-2rem)] w-[300px] flex-col gap-3 overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-3 shadow-xl", className)}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-foreground">{t("files.appearanceTitle")}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onChange(DEFAULT_BOX_APPEARANCE)}
            title={t("files.appearanceReset")}
            aria-label={t("files.appearanceReset")}
            className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RotateCcw className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            title={t("files.appearanceClose")}
            aria-label={t("files.appearanceClose")}
            className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      <Row label={t("files.appearanceIconSize")} value={`${a.iconSize}px`}>
        <input
          type="range"
          min={20}
          max={64}
          step={2}
          value={a.iconSize}
          onChange={(e) => set("iconSize", Number(e.target.value))}
          className="accent-[var(--brand)]"
        />
      </Row>

      <Row label={t("files.appearanceName")}>
        <Segmented
          ariaLabel={t("files.appearanceName")}
          value={a.nameMode}
          onChange={(value) => set("nameMode", value)}
          options={[
            { value: "full", label: t("files.fileNameFull") },
            { value: "noExt", label: t("files.fileNameNoExt") },
            { value: "extOnly", label: t("files.fileNameExtOnly") },
            { value: "none", label: t("files.fileNameNone") },
          ]}
        />
      </Row>

      <div className="grid grid-cols-2 gap-2">
        <Row label={t("files.appearanceFont")}>
          <select
            value={a.fontFamily}
            onChange={(e) => set("fontFamily", e.target.value as BoxFontFamily)}
            className="h-7 w-full rounded-md border border-border bg-card px-1.5 text-[11px] text-foreground"
          >
            <option value="system">{t("files.appearanceFontSystem")}</option>
            <option value="segoe">{t("files.appearanceFontSegoe")}</option>
            <option value="yahei">{t("files.appearanceFontYahei")}</option>
            <option value="mono">{t("files.appearanceFontMono")}</option>
          </select>
        </Row>
        <Row label={t("files.appearanceFontSize")} value={`${a.fontSize}px`}>
          <input
            type="range"
            min={8}
            max={18}
            step={1}
            value={a.fontSize}
            onChange={(e) => set("fontSize", Number(e.target.value))}
            className="accent-[var(--brand)]"
          />
        </Row>
      </div>

      <Row label={t("files.appearanceTitleBar")}>
        <Segmented
          ariaLabel={t("files.appearanceTitleBar")}
          value={a.titleBar}
          onChange={(value) => set("titleBar", value)}
          options={[
            { value: "always", label: t("files.appearanceTitleAlways") },
            { value: "auto", label: t("files.appearanceTitleAuto") },
            { value: "hidden", label: t("files.appearanceTitleHidden") },
          ]}
        />
      </Row>

      <div className="grid grid-cols-2 gap-2">
        <Row label={t("files.appearanceAlpha")} value={`${Math.round(a.backgroundAlpha * 100)}%`}>
          <input
            type="range"
            min={45}
            max={100}
            step={1}
            value={Math.round(a.backgroundAlpha * 100)}
            onChange={(e) => set("backgroundAlpha", Number(e.target.value) / 100)}
            className="accent-[var(--brand)]"
          />
        </Row>
        <Row label={t("files.appearanceRadius")} value={`${a.radius}px`}>
          <input
            type="range"
            min={0}
            max={28}
            step={1}
            value={a.radius}
            onChange={(e) => set("radius", Number(e.target.value))}
            className="accent-[var(--brand)]"
          />
        </Row>
      </div>

      {onGroupColor && (
        <Row label={t("files.appearanceGroup")}>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              aria-pressed={!category.groupColor}
              title={t("files.appearanceGroupNone")}
              onClick={() => onGroupColor(undefined)}
              className={cn(
                "grid size-6 place-items-center rounded-full border text-[10px]",
                !category.groupColor ? "border-brand text-brand" : "border-border text-muted-foreground",
              )}
            >
              ×
            </button>
            {GROUP_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-pressed={category.groupColor === color}
                aria-label={color}
                onClick={() => onGroupColor(color)}
                className={cn(
                  "size-6 rounded-full border-2 transition-transform",
                  category.groupColor === color ? "scale-110 border-foreground" : "border-white/60 hover:scale-105",
                )}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
          <p className="text-[10px] leading-4 text-muted-foreground">{t("files.appearanceGroupHint")}</p>
          {category.groupColor && onMerge && (
            <button type="button" onClick={onMerge}
              className="mt-0.5 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-foreground hover:bg-muted">
              {t("files.appearanceMergeHost")}
            </button>
          )}
        </Row>
      )}

      <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
        <label className="flex items-center justify-between gap-2 text-[11px] text-foreground/80">
          <span>{t("files.appearanceTextPreview")}</span>
          <input
            type="checkbox"
            checked={a.showTextPreview}
            onChange={(e) => set("showTextPreview", e.target.checked)}
            className="size-3.5 accent-[var(--brand)]"
          />
        </label>
        <label className="flex items-center justify-between gap-2 text-[11px] text-foreground/80">
          <span>{t("files.appearanceMediaPreview")}</span>
          <input
            type="checkbox"
            checked={a.showMediaPreview}
            onChange={(e) => set("showMediaPreview", e.target.checked)}
            className="size-3.5 accent-[var(--brand)]"
          />
        </label>
        <p className="text-[10px] leading-4 text-muted-foreground">{t("files.appearanceHint")}</p>
      </div>
    </div>
  );
}
