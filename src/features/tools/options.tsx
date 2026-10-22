import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { codeLanguages, formats, namingKinds, namingStyle, type ToolId, type ToolOptions } from "./core";
import type { ToolsCopy } from "./copy";

const languages = [["English", "English"], ["Simplified Chinese", "简体中文"], ["Traditional Chinese", "繁體中文"], ["Japanese", "日本語"], ["Korean", "한국어"], ["German", "Deutsch"], ["French", "Français"], ["Spanish", "Español"]];

/**
 * 一个下拉选项。
 *
 * 原生 `<select>` 在 Windows 上是系统画的：深色主题里弹出来是浅灰底的
 * 系统菜单，和这套界面完全不是一个东西 —— 换成全应用统一的那套 Radix
 * 组件（`components/ui/select`）。取值/回调语义不变：仍是「一个字符串 in、
 * 一个字符串 out」，所以调用方只把 option 列表改成数组字面量。
 *
 * 标签用 `<span id>` + `aria-labelledby` 而不是 `<label for>`：Radix 触发器
 * 自己是 button，包在 label 里点文字会把弹出层开了又关。
 */
function Field({ label, id, value, onChange, options }: {
  label: string;
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return <div className="tool-option">
    <span id={`${id}-label`}>{label}</span>
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} aria-labelledby={`${id}-label`} className="tool-select">
        <SelectValue />
      </SelectTrigger>
      {/* portal + 触发器同宽：选项再长也不会把窄容器撑破或被面板裁掉 */}
      <SelectContent position="popper" sideOffset={4} align="start" className="tool-select-content">
        {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  </div>;
}

export function ToolOptionsBar({ tool, options, update, c }: { tool: ToolId; options: ToolOptions; update: (change: Partial<ToolOptions>) => void; c: ToolsCopy }) {
  return <div className="tool-options">
    {tool === "format" && <>
      <Field id="tool-option-format" label={c.formatLabel} value={options.format} onChange={(format) => update({ format: format as ToolOptions["format"] })}
        options={Object.entries(formats).map(([value, label]) => ({ value, label }))} />
      <Field id="tool-option-mode" label={c.mode} value={options.mode} onChange={(mode) => update({ mode: mode as ToolOptions["mode"] })}
        options={(["repair", "optimize", "explain"] as const).map((value) => ({ value, label: c[value] }))} />
    </>}
    {tool === "translate" && <>
      <Field id="tool-option-source" label={c.sourceLanguage} value={options.sourceLanguage} onChange={(sourceLanguage) => update({ sourceLanguage })}
        options={[{ value: "auto", label: c.auto }, ...languages.map(([value, label]) => ({ value, label }))]} />
      <Field id="tool-option-target" label={c.target} value={options.target} onChange={(target) => update({ target })}
        options={languages.map(([value, label]) => ({ value, label }))} />
      <Field id="tool-option-style" label={c.style} value={options.translationStyle} onChange={(translationStyle) => update({ translationStyle: translationStyle as ToolOptions["translationStyle"] })}
        options={(["technical", "natural", "literal"] as const).map((value) => ({ value, label: c[value] }))} />
    </>}
    {tool === "naming" && <>
      <Field id="tool-option-language" label={c.codeLanguage} value={options.codeLanguage} onChange={(codeLanguage) => update({ codeLanguage })}
        options={codeLanguages.map((value) => ({ value, label: value }))} />
      <Field id="tool-option-kind" label={c.namingKind} value={options.namingKind} onChange={(namingKind) => update({ namingKind: namingKind as ToolOptions["namingKind"] })}
        options={namingKinds.map((value) => ({ value, label: c[value] }))} />
      <span className="tool-convention" title={c.nameStyle}>{namingStyle(options.codeLanguage, options.namingKind)}</span>
    </>}
  </div>;
}
