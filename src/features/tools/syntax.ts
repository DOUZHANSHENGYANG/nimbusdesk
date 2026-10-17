import { parseDocument } from "yaml";
import { parse as parseToml } from "smol-toml";
import { XMLValidator } from "fast-xml-parser";

export interface SyntaxCheck { status: "valid" | "invalid" | "unverified"; message: string; line?: number }

function parseValue(format: string, text: string): unknown {
  if (format === "json") JSON.parse(text);
  if (format === "json" || format === "yaml") {
    // Preserve large integers when comparing otherwise valid configuration values.
    const document = parseDocument(text, { intAsBigInt: true, uniqueKeys: true });
    if (document.errors.length) throw document.errors[0];
    return document.toJS({ maxAliasCount: 20 });
  }
  if (format === "toml") return parseToml(text, { integersAsBigInt: true });
  if (format === "xml") {
    const result = XMLValidator.validate(text);
    if (result !== true) throw Object.assign(new Error(result.err.msg), { line: result.err.line });
    return text;
  }
  throw new Error("UNVERIFIED_FORMAT");
}

export function checkSyntax(format: string, text: string): SyntaxCheck {
  if (!["json", "yaml", "toml", "xml"].includes(format)) return { status: "unverified", message: "" };
  try { if (format === "json") JSON.parse(text); else parseValue(format, text); return { status: "valid", message: "" }; }
  catch (error) {
    const failure = error as { message?: string; line?: number; linePos?: { line: number }[] };
    return { status: "invalid", message: String(failure.message ?? "Invalid syntax").slice(0, 500), line: failure.line ?? failure.linePos?.[0]?.line };
  }
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return `bigint:${value}`;
  // Parsers retain integers as BigInt, but JS numbers cannot prove decimal
  // precision. Report "unknown" rather than a false unchanged-value guarantee.
  if (typeof value === "number") throw new Error("DECIMAL_COMPARISON_UNAVAILABLE");
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",") + "}";
  return JSON.stringify(value) ?? String(value);
}

/** null means no reliable local comparison; source text is never rewritten here. */
export function semanticChange(format: string, before: string, after: string): boolean | null {
  if (!["json", "yaml", "toml"].includes(format)) return null;
  try { return canonical(parseValue(format, before)) !== canonical(parseValue(format, after)); }
  catch { return null; }
}
