/**
 * 预设相关后端错误 → 当前界面语言。
 *
 * 后端以 `码: 详情` 形式返回（如 `preset.nameDuplicate: 预设名称已存在：前端`）；
 * 前端只按码翻译，详情按需插入；没有匹配码的原样展示（IO / 未预期错误）。
 */
const PRESET_ERROR_CODES = [
  "preset.nameRequired",
  "preset.nameDuplicate",
  "preset.notFound",
  "preset.corrupt",
  "preset.io",
  "preset.targetMissing",
] as const;

type PresetErrorCode = (typeof PRESET_ERROR_CODES)[number];

export function presetErrorText(raw: unknown, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const text = String(raw ?? "").trim();
  if (!text) return text;

  const idx = text.indexOf(":");
  const code = (idx >= 0 ? text.slice(0, idx) : text).trim() as PresetErrorCode;
  const detail = idx >= 0 ? text.slice(idx + 1).trim() : "";

  if (!PRESET_ERROR_CODES.includes(code)) return text;

  if (code === "preset.corrupt") {
    // 后端把「路径|原因」放在详情里：路径给用户看，原因附在后面便于排查
    const [path, reason] = detail.split("|");
    const base = t("preset.corrupt", { path: (path ?? "").trim() });
    return reason ? `${base} ${t("preset.corruptHint")} ${reason.trim()}` : `${base} ${t("preset.corruptHint")}`;
  }
  if (code === "preset.io") {
    return t("preset.io", { error: detail });
  }
  return t(code);
}
