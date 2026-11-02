/** README 抽屉：原始 markdown → ReactMarkdown；划词翻译挂在这个容器上。 */
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, ExternalLink, LoaderCircle, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/stores/settings";
import { fetchReadme } from "./github-api";
import type { GithubCopy } from "./github-copy";
import type { GithubRepo } from "./github-types";
import { SelectionTranslate } from "./github-selection-translate";

export function GithubReadme({ repo, token, copy, cached, onLoaded, starred, onStarToggle, onClose }: {
  repo: GithubRepo;
  token: string;
  copy: GithubCopy;
  /** 上次读到的 README 原文：先渲染它，再后台取最新 */
  cached?: string;
  onLoaded?: (markdown: string) => void;
  starred: boolean;
  onStarToggle: () => void;
  onClose: () => void;
}) {
  const lang = useSettings(s => s.lang);
  const [markdown, setMarkdown] = useState<string | null>(cached ?? null);
  const [failed, setFailed] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Esc 与项目页的抽屉一致：先关抽屉，别让用户去找返回
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    setFailed(false);
    // 有缓存就不清空：内容留在屏幕上，取到新的再替换。
    setMarkdown(current => current ?? null);
    fetchReadme(token, repo)
      .then(text => {
        if (!live) return;
        setMarkdown(text);
        onLoaded?.(text);
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [token, repo.fullName]);

  return <div className="absolute inset-y-0 right-0 z-20 flex w-full max-w-[620px] flex-col border-l border-border bg-background shadow-xl">
    <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <Button variant="ghost" size="icon-sm" title={copy.close} aria-label={copy.close} onClick={onClose}><ArrowLeft /></Button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{repo.fullName}</p>
        <p className="truncate text-[11px] text-muted-foreground">{repo.description || copy.readme}</p>
      </div>
      {repo.fork && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{copy.fork}</span>}
      <Button variant="ghost" size="icon-sm" title={starred ? copy.unstar : copy.star} aria-label={starred ? copy.unstar : copy.star} aria-pressed={starred} onClick={onStarToggle}>
        <Star className={starred ? "fill-current text-amber-500" : undefined} />
      </Button>
      <Button variant="ghost" size="icon-sm" title={copy.open} aria-label={copy.open} onClick={() => void openUrl(repo.htmlUrl).catch(() => {})}><ExternalLink /></Button>
    </header>
    <div ref={body} className="md-body selectable min-h-0 flex-1 overflow-auto px-4 py-3 break-words leading-relaxed">
      {failed ? <p className="text-sm text-destructive">{copy.readmeFailed}</p>
        : markdown === null ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />{copy.loading}</p>
        : markdown.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => /^https?:\/\//i.test(url) || url.startsWith("#") ? url : ""} components={{
            img: ({ alt }) => <span className="text-muted-foreground">[{alt}]</span>,
            a: ({ href, children }) => <a href={href} className="text-primary underline underline-offset-2" onClick={event => { event.preventDefault(); if (href && /^https?:\/\//i.test(href)) void openUrl(href).catch(() => {}); }}>{children}</a>,
          }}>{markdown}</ReactMarkdown>
        : <p className="text-sm text-muted-foreground">{copy.readmeEmpty}</p>}
    </div>
    <SelectionTranslate containerRef={body} to={lang === "zh" ? "zh-Hans" : "en"} copy={copy} />
  </div>;
}
