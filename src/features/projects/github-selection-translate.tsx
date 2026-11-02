/**
 * README 里的划词翻译：选中 → 浮出一个小按钮 → 点了才发请求（两段式，选中本身不联网）。
 * 只在容器内生效，避免和整页其他选择区打架。
 */
import { useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { translateSelection } from "./github-api";
import type { GithubCopy } from "./github-copy";
import type { TranslationResult } from "./github-types";

interface Anchor {
  x: number;
  y: number;
  text: string;
  /** true = 浮层展开在选区上方 */
  flip: boolean;
}

export function SelectionTranslate({ containerRef, to, copy }: {
  containerRef: React.RefObject<HTMLElement | null>;
  to: string;
  copy: GithubCopy;
}) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const popover = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const read = () => {
      const selection = window.getSelection();
      const container = containerRef.current;
      if (!container || !selection || !selection.rangeCount) { setAnchor(null); setResult(null); return; }
      const range = selection.getRangeAt(0);
      // 用 Range 取文本和位置：Selection.toString() 在无头环境里会返回空串，Range 不会。
      const text = range.toString().trim();
      const inside = container.contains(range.startContainer) && container.contains(range.endContainer);
      // 整篇全选不翻译：一次只有一两句才有意义，也免得把整页塞给翻译接口。
      if (!inside || !text || text.length > 1200) {
        setAnchor(null); setResult(null); return;
      }
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      // 底部空间不够就把浮层翻到选区上方，别压住接下来要读的行
      const flip = rect.bottom > window.innerHeight - 140;
      setAnchor({ x: rect.left + rect.width / 2, y: flip ? rect.top : rect.bottom, text, flip });
      setResult(null); setFailed(false); setCopied(false);
    };
    const onUp = (event: MouseEvent) => {
      if (popover.current?.contains(event.target as Node)) return;
      // 等浏览器把选区更新完再读，否则拿到上一段。
      requestAnimationFrame(read);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setAnchor(null); setResult(null); }
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keydown", onKey);
    };
  }, [containerRef]);

  async function run() {
    if (!anchor || busy) return;
    setBusy(true); setFailed(false);
    try {
      setResult(await translateSelection(anchor.text, to));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (!anchor) return null;
  const left = Math.min(Math.max(anchor.x, 160), Math.max(window.innerWidth - 160, 160));

  return (
    <div ref={popover} className="fixed z-50 w-max max-w-[min(380px,90vw)]" style={{ left, top: anchor.flip ? undefined : anchor.y + 6, bottom: anchor.flip ? window.innerHeight - anchor.y + 6 : undefined, transform: "translateX(-50%)" }}>
      {!result && !failed ? (
        <button type="button" onClick={() => void run()} disabled={busy} className="flex items-center gap-1.5 rounded-md bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-md ring-1 ring-border hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70">
          {busy ? copy.translating : copy.translate}
        </button>
      ) : (
        <div role="status" className="rounded-md bg-popover p-2.5 shadow-md ring-1 ring-border">
          {failed ? <p className="text-xs text-destructive">{copy.translationFailed}</p> : <>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{result?.text}</p>
            <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>{result?.engine === "ai" ? copy.engineAi : copy.engineEdge}</span>
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => { void writeText(result?.text ?? "").then(() => setCopied(true)).catch(() => setCopied(false)); }}>
                {copied ? copy.copied : copy.copyTranslation}
              </button>
            </div>
          </>}
        </div>
      )}
    </div>
  );
}
