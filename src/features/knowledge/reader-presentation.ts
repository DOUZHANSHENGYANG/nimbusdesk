import { frontmatterRange } from "./metadata.ts";

/** Preview only. Never edit the saved Markdown or remove a non-leading heading. */
export function previewWithoutRepeatedTitle(content: string, title: string): string {
  try {
    const start = frontmatterRange(content)?.body ?? 0;
    const body = content.slice(start);
    const heading = /^(?:[ \t]*\r?\n)* {0,3}#[ \t]+([^\r\n]+)(?:\r?\n|$)/.exec(body);
    if (!heading || heading[1].replace(/[ \t]+#+[ \t]*$/, "").trim() !== title.trim()) return content;
    return content.slice(0, start) + body.slice(heading[0].length);
  } catch { return content; }
}
