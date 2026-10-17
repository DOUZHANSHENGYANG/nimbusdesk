import type { ReactNode } from "react";
import { codeLanguages, formats, namingKinds, namingStyle, type ToolId, type ToolOptions } from "./core";
import type { ToolsCopy } from "./copy";

const languages = [["English", "English"], ["Simplified Chinese", "简体中文"], ["Traditional Chinese", "繁體中文"], ["Japanese", "日本語"], ["Korean", "한국어"], ["German", "Deutsch"], ["French", "Français"], ["Spanish", "Español"]];
function Field({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  return <label className="tool-option"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{children}</select></label>;
}

export function ToolOptionsBar({ tool, options, update, c }: { tool: ToolId; options: ToolOptions; update: (change: Partial<ToolOptions>) => void; c: ToolsCopy }) {
  return <div className="tool-options">
    {tool === "format" && <>
      <Field label={c.formatLabel} value={options.format} onChange={(format) => update({ format: format as ToolOptions["format"] })}>{Object.entries(formats).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</Field>
      <Field label={c.mode} value={options.mode} onChange={(mode) => update({ mode: mode as ToolOptions["mode"] })}>{(["repair", "optimize", "explain"] as const).map((value) => <option value={value} key={value}>{c[value]}</option>)}</Field>
    </>}
    {tool === "translate" && <>
      <Field label={c.sourceLanguage} value={options.sourceLanguage} onChange={(sourceLanguage) => update({ sourceLanguage })}><option value="auto">{c.auto}</option>{languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Field>
      <Field label={c.target} value={options.target} onChange={(target) => update({ target })}>{languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Field>
      <Field label={c.style} value={options.translationStyle} onChange={(translationStyle) => update({ translationStyle: translationStyle as ToolOptions["translationStyle"] })}>{(["technical", "natural", "literal"] as const).map((value) => <option key={value} value={value}>{c[value]}</option>)}</Field>
    </>}
    {tool === "naming" && <>
      <Field label={c.codeLanguage} value={options.codeLanguage} onChange={(codeLanguage) => update({ codeLanguage })}>{codeLanguages.map((value) => <option key={value}>{value}</option>)}</Field>
      <Field label={c.namingKind} value={options.namingKind} onChange={(namingKind) => update({ namingKind: namingKind as ToolOptions["namingKind"] })}>{namingKinds.map((value) => <option key={value} value={value}>{c[value]}</option>)}</Field>
      <span className="tool-convention" title={c.nameStyle}>{namingStyle(options.codeLanguage, options.namingKind)}</span>
    </>}
  </div>;
}
