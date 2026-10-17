import { useEffect, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import { ExternalLink, ImageOff } from "lucide-react";
import { openUrl } from "@/lib/tauri";
import { imageData } from "./api";
import { remarkWikiLinks, vaultImagePath } from "./markdown-links";
import { useKnowledgeCopy } from "./copy";
import "./markdown.css";

function VaultImage({ root, path, alt }: { root: string; path: string; alt: string }) {
  const [data, setData] = useState("");
  const [failed, setFailed] = useState(false);
  const c = useKnowledgeCopy();
  useEffect(() => {
    let current = true;
    setData(""); setFailed(false);
    void imageData(root, path).then((value) => { if (current) setData(value); }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [root, path]);
  return data ? <img src={data} alt={alt} loading="lazy" /> : <span className="my-3 flex items-center gap-2 text-xs text-muted-foreground"><ImageOff className="size-4" />{failed ? c.imageError : c.loading} · {alt}</span>;
}

export function NoteMarkdown({ root, path, content, onError }: { root: string; path: string; content: string; onError: (error: string) => void }) {
  function open(href: string) {
    let target: string;
    try {
      if (href.startsWith("vault-note:")) {
        const file = decodeURIComponent(href.slice("vault-note:".length));
        const vault = root.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop() || "";
        target = `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(file)}`;
      } else if (/^https?:\/\//i.test(href)) target = href;
      else if (href.startsWith("#")) return;
      else {
        const file = decodeURIComponent(href);
        if (file.includes(":") || file.startsWith("//")) return;
        target = `obsidian://open?path=${encodeURIComponent(`${root.replace(/[\\/]$/, "")}/${path.split("/").slice(0, -1).join("/")}/${file}`)}`;
      }
      void openUrl(target).catch((error) => onError(String(error)));
    } catch (error) { onError(String(error)); }
  }
  return <div className="note-markdown select-text">
    <Markdown remarkPlugins={[remarkGfm, remarkFrontmatter, remarkWikiLinks]} skipHtml
      urlTransform={(url) => /^(vault-note|vault-image):/.test(url) ? url : defaultUrlTransform(url)}
      components={{
        a: ({ href, children }) => <a href={href || "#"} onClick={(event) => { if (!href?.startsWith("#")) event.preventDefault(); if (href) open(href); }}>{children}</a>,
        img: ({ src, alt }) => {
          if (!src || typeof src !== "string") return null;
          const source = src.startsWith("vault-image:") ? src.slice("vault-image:".length) : src;
          const resolved = vaultImagePath(source, path);
          if (resolved) return <VaultImage root={root} path={resolved} alt={alt || resolved} />;
          return <button type="button" className="inline-flex items-center gap-1.5 text-xs text-brand" onClick={() => open(src)}><ExternalLink className="size-3" />{alt || src}</button>;
        },
        table: ({ children }) => <div className="note-table-scroll"><table>{children}</table></div>,
      }}>{content}</Markdown>
  </div>;
}
