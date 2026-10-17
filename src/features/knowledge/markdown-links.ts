export interface MarkdownNode { type: string; value?: string; url?: string; alt?: string; children?: MarkdownNode[] }
/** Transform text nodes only: code and existing links remain literal. */
export function remarkWikiLinks() {
  return function walk(tree: MarkdownNode) {
    if (!tree.children || ["link", "code", "inlineCode", "html", "yaml"].includes(tree.type)) return;
    tree.children = tree.children.flatMap((node) => {
      if (node.type !== "text" || !node.value) { walk(node); return [node]; }
      const parts: MarkdownNode[] = [];
      let end = 0;
      for (const match of node.value.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
        const start = match.index!;
        if (start > end) parts.push({ type: "text", value: node.value.slice(end, start) });
        const [target, alias] = match[2].split("|");
        const image = !!match[1] && /\.(png|jpe?g|webp|gif)$/i.test(target);
        const label = alias && !/^\d+(x\d+)?$/.test(alias) ? alias : target.split("/").pop() || target;
        parts.push(image
          ? { type: "image", url: `vault-image:${encodeURIComponent(target)}`, alt: label }
          : { type: "link", url: `vault-note:${encodeURIComponent(target)}`, children: [{ type: "text", value: label }] });
        end = start + match[0].length;
      }
      if (!parts.length) return [node];
      if (end < node.value.length) parts.push({ type: "text", value: node.value.slice(end) });
      return parts;
    });
  };
}

export function vaultImagePath(source: string, notePath: string): string | null {
  let path: string;
  try { path = decodeURIComponent(source).replace(/\\/g, "/"); } catch { return null; }
  if (/[\0:]/.test(path)) return null;
  const absolute = path.startsWith("assets/images/") || path.startsWith("/");
  if (absolute && path.split("/").includes("..")) return null;
  const segments = absolute ? [] : notePath.replace(/\\/g, "/").split("/").slice(0, -1);
  for (const segment of path.split("/")) {
    if (segment === "..") { if (!segments.length) return null; segments.pop(); }
    else if (segment && segment !== ".") segments.push(segment);
  }
  const resolved = segments.join("/");
  return resolved.startsWith("assets/images/") ? resolved : null;
}
