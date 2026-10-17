import { useEffect, useMemo, useRef, useState } from "react";
import { diffLines } from "diff";
import { CheckCheck, Copy, FileCode2, TriangleAlert } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ToolId } from "./core";
import type { ToolResult } from "./request";
import type { ToolsCopy } from "./copy";

function CopyAction({ text, name, iconOnly = false, copy, c }: { text: string; name: string; iconOnly?: boolean; copy: (text: string) => Promise<boolean>; c: ToolsCopy }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = useRef(true);
  const value = useRef(text);
  value.current = text;
  useEffect(() => {
    active.current = true;
    setCopied(false);
    return () => { active.current = false; if (timer.current) clearTimeout(timer.current); };
  }, [text]);
  return <button className={iconOnly ? "tool-icon-button tool-copy" : "tool-copy"} aria-label={name} title={copied ? c.copied : name} data-copied={copied} onClick={async () => {
    if (!await copy(text) || !active.current || value.current !== text) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1_600);
  }}>{copied ? <CheckCheck /> : <Copy />}{iconOnly ? <span className="sr-only" role="status">{copied ? c.copied : ""}</span> : <span role="status">{copied ? c.copied : c.copy}</span>}</button>;
}

function Diff({ result, c }: { result: ToolResult; c: ToolsCopy }) {
  const changes = useMemo(() => diffLines(result.source, result.text, { timeout: 100, maxEditLength: 2_000 }), [result.source, result.text]);
  if (result.source === result.text) return <p className="tool-note">{c.noChanges}</p>;
  if (!changes || changes.length > 1_000) return <p className="tool-note">{c.diffLimit}</p>;
  return <pre className="tool-diff" tabIndex={0} aria-label={c.diff}>{changes.map((change, index) => <span key={index} data-change={change.added ? "added" : change.removed ? "removed" : "same"}><b aria-hidden="true">{change.added ? "+" : change.removed ? "−" : " "}</b>{change.value}</span>)}</pre>;
}

export function ToolResults({ tool, result, stale, c, copy, apply }: { tool: ToolId; result: ToolResult | null; stale: boolean; c: ToolsCopy; copy: (text: string) => Promise<boolean>; apply: () => void }) {
  const [view, setView] = useState<"text" | "diff">("text");
  if (!result) return <div className="tool-empty"><FileCode2 aria-hidden="true" /><h3>{c.emptyResult}</h3><p>{c.emptyHint}</p></div>;
  return <div className="tool-result-body">
    {stale && <p role="status" className="tool-notice tool-warning"><TriangleAlert />{c.stale}</p>}
    <p className="tool-summary">{result.summary}</p>
    {tool === "format" && <>
      <div className={`tool-check ${result.check.status === "invalid" ? "tool-warning" : ""}`}>
        {result.check.status === "valid" ? <CheckCheck /> : <TriangleAlert />}
        <span>{result.check.status === "valid" ? c.syntaxValid : result.check.status === "invalid" ? c.syntaxInvalid : c.unchecked}{result.check.line ? ` · ${c.line} ${result.check.line}` : ""}</span>
      </div>
      {result.check.message && <pre className="tool-parser-error">{result.check.message}</pre>}
      {result.semanticsChanged !== null && <p className={`tool-note ${result.semanticsChanged ? "tool-warning" : ""}`}>{result.semanticsChanged ? c.semanticWarning : c.semanticSame}</p>}
    </>}
    {tool === "naming" ? <ol className="tool-names">{result.candidates.map((candidate, index) => <li key={candidate.name}>
      <span className="tool-name-index">{String(index + 1).padStart(2, "0")}</span><div><code>{candidate.name}</code><p>{candidate.meaning}</p><small>{candidate.reason}</small></div>
      <CopyAction iconOnly text={candidate.name} name={`${c.copyName} ${candidate.name}`} copy={copy} c={c} />
    </li>)}</ol> : <>
      <div className="tool-output-toolbar">
        {tool === "format" ? <div className="tool-view" role="group" aria-label={c.result}><button aria-pressed={view === "text"} onClick={() => setView("text")}>{c.output}</button><button aria-pressed={view === "diff"} onClick={() => setView("diff")}>{c.diff}</button></div> : <span />}
        <div className="tool-actions"><CopyAction text={result.text} name={c.copy} copy={copy} c={c} />{tool === "format" && <button disabled={stale || result.check.status === "invalid" || result.source === result.text} onClick={apply}>{c.apply}</button>}</div>
      </div>
      {tool === "format" && view === "diff" ? <Diff result={result} c={c} /> : tool === "diagnose" || tool === "regex" ? <div className="tool-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{result.text}</ReactMarkdown></div> : <pre className={`tool-output ${tool === "format" ? "tool-code" : ""}`} tabIndex={0} aria-label={c.output}>{result.text}</pre>}
    </>}
    {result.notes.length > 0 && <section className="tool-notes"><h3>{c.notes}</h3><ul>{result.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></section>}
    {tool === "regex" && <p className="tool-note">{c.regexNotice}</p>}
  </div>;
}
