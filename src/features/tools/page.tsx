import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Braces, Languages, CaseSensitive, Bug, Regex, Settings2, Sparkles, LoaderCircle, RotateCcw, FileUp, Info, CheckCheck, Circle, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/motion/button/base";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { chatWithProvider } from "@/features/ai/client";
import { useProviders } from "@/features/ai/providers";
import { useSettings } from "@/stores/settings";
import { copyText } from "@/lib/clipboard";
import { toolIds, buildMessages, type ToolId } from "./core";
import { useToolsCopy } from "./copy";
import { toolErrorMessage } from "./errors";
import { openQuickToolsWindow } from "@/features/search/api";
import { useToolsPreferences } from "./preferences";
import { runTool, StaleToolRequest, type ToolResult } from "./request";
import { checkSyntax } from "./syntax";
import { ToolOptionsBar } from "./options";
import { ToolResults } from "./results";
import { PromptPreferences } from "./prompt-preferences";
import "./tools.css";

const icons = { format: Braces, translate: Languages, naming: CaseSensitive, diagnose: Bug, regex: Regex };
const examples: Record<ToolId, string> = {
  format: '{\n  "name": "云台"\n  "features": ["计划", "开发知识", "工具"],\n  "enabled": true\n}',
  translate: "本次更新修复了后台任务重复运行的问题。请保留 `taskId` 与 {{projectName}} 占位符。",
  naming: "根据用户编号，获取该用户尚未支付的订单列表。名称要清晰，不使用缩写。",
  diagnose: "TypeError: Cannot read properties of undefined (reading 'map')\n\nconst [users, setUsers] = useState();\nreturn users.map(user => <li key={user.id}>{user.name}</li>);\n\n环境：React + TypeScript，首次打开页面时报错。",
  regex: "JavaScript：校验由英文字母、数字和下划线组成的用户名；首字符必须是字母，总长度 3–20。请给出正例与反例。",
};
interface Draft { input: string; result: ToolResult | null; resultKey: string; error: string; undo: string | null }
const draftsInitial = () => Object.fromEntries(toolIds.map((tool) => [tool, { input: "", result: null, resultKey: "", error: "", undo: null }])) as Record<ToolId, Draft>;

export function ToolsPage() {
  const c = useToolsCopy();
  const [params] = useSearchParams();
  const requestedTool = params.get("tool");
  const lang = useSettings((state) => state.lang);
  const navigate = useNavigate();
  const providers = useProviders((state) => state.providers);
  const defaultId = useProviders((state) => state.defaultTextId);
  const provider = providers.find((item) => item.id === defaultId);
  const [tool, setTool] = useState<ToolId>("format");
  useEffect(() => { if (toolIds.some(id => id === requestedTool)) setTool(requestedTool as ToolId); }, [requestedTool]);
  const options = useToolsPreferences((state) => state.options[tool]);
  const updateOptions = useToolsPreferences((state) => state.update);
  const [drafts, setDrafts] = useState(draftsInitial);
  const draftsRef = useRef(drafts);
  const alive = useRef(true);
  const lock = useRef(false);
  const [job, setJob] = useState<ToolId | null>(null);
  const [live, setLive] = useState(false);
  const liveAttempt = useRef("");
  const fileInput = useRef<HTMLInputElement>(null);
  const draft = drafts[tool];
  const deferredInput = useDeferredValue(draft.input);
  const syntax = useMemo(() => deferredInput.trim() ? checkSyntax(options.format, deferredInput) : null, [options.format, deferredInput]);
  const optionsKey = JSON.stringify(options);
  const resultKey = JSON.stringify({ options, lang });
  const stale = Boolean(draft.result && (draft.result.source !== draft.input || draft.resultKey !== resultKey));
  const Icon = icons[tool];

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const change = useCallback((id: ToolId, patch: Partial<Draft>) => {
    const next = { ...draftsRef.current, [id]: { ...draftsRef.current[id], ...patch } };
    draftsRef.current = next;
    setDrafts(next);
  }, []);
  const run = useCallback(async (id: ToolId) => {
    if (lock.current) return;
    const source = draftsRef.current[id].input;
    const snapshot = { ...useToolsPreferences.getState().options[id] };
    const language = useSettings.getState().lang;
    const key = JSON.stringify({ options: snapshot, lang: language });
    liveAttempt.current = source + key;
    lock.current = true;
    setJob(id);
    change(id, { error: "" });
    const current = () => alive.current && draftsRef.current[id].input === source
      && JSON.stringify({ options: useToolsPreferences.getState().options[id], lang: useSettings.getState().lang }) === key;
    try {
      const result = await runTool(id, source, snapshot, language, chatWithProvider, current);
      if (current()) change(id, { result, resultKey: key });
    } catch (error) { if (current() && !(error instanceof StaleToolRequest)) change(id, { error: toolErrorMessage(error, c) }); }
    finally { lock.current = false; if (alive.current) setJob(null); }
  }, [change, c]);

  useEffect(() => {
    if (tool !== "translate" || !live || job || !provider || !draft.input.trim() || draft.input.length > 120_000 || liveAttempt.current === draft.input + resultKey) return;
    const timer = setTimeout(() => { void run("translate"); }, 1_000);
    return () => clearTimeout(timer);
  }, [tool, live, job, provider, draft.input, resultKey, run]);

  async function copy(text: string) { const ok = await copyText(text); if (!ok) toast.error(c.copyFailed); return ok; }
  const systemPrompt = useMemo(() => buildMessages(tool, "example", { ...options, instruction: "" }, lang)[0].content as string, [tool, optionsKey, lang]);
  const runLabel = c[`${tool}Run`];

  return <div className="developer-tools workbench-ui">
    <header className="tools-header"><h1>{c.title}</h1><button className="tools-quick-panel" onClick={() => void openQuickToolsWindow().catch(() => toast.error(c.failed))}><Sparkles />{lang === "zh" ? "快捷工具" : "Quick tools"}</button><button className="tools-provider" onClick={() => navigate("/settings?tab=ai")} title={c.configure}><span className="tools-model-dot" data-connected={Boolean(provider)} /><span><small>{c.shared}</small><strong>{provider?.model || c.unconfigured}</strong></span><Settings2 /></button></header>
    <div className="tools-layout">
      <nav className="tools-nav" aria-label={c.title}>{toolIds.map((id) => { const ToolIcon = icons[id]; return <button key={id} aria-current={tool === id ? "page" : undefined} onClick={() => setTool(id)}>{job === id ? <LoaderCircle className="animate-spin" /> : <ToolIcon />}<span>{c[id]}</span></button>; })}</nav>
      <section className="tools-workspace" aria-label={c[tool]}>
        <div className="tools-heading"><div className="tools-heading-icon"><Icon /></div><div><h2>{c[tool]}</h2><p>{c[`${tool}Hint`]}</p></div></div>
        <div className="tool-configuration">
          <ToolOptionsBar tool={tool} options={options} update={(patch) => updateOptions(tool, patch)} c={c} />
          <div className="tool-configuration-actions">
            {tool === "translate" && <Tooltip><TooltipTrigger asChild><div className="tool-live"><label htmlFor="tool-live">{c.live}</label><Switch id="tool-live" checked={live} onCheckedChange={setLive} aria-describedby="tool-live-hint" /><span className="sr-only" id="tool-live-hint">{c.liveHint}</span></div></TooltipTrigger><TooltipContent>{c.liveHint}</TooltipContent></Tooltip>}
            <PromptPreferences key={tool} value={options.instruction} onChange={(instruction) => updateOptions(tool, { instruction })} prompt={systemPrompt} c={c} />
          </div>
        </div>
        <div className="tools-panes">
          <section className="tool-input-pane" aria-label={c.source}>
            <div className="tool-pane-label"><div className="tool-input-label"><label htmlFor="tool-input">{c.source}</label><span title={c.tooLarge}>{draft.input.length.toLocaleString()} {c.chars}</span></div><div className="tool-actions"><button onClick={() => change(tool, { input: examples[tool], error: "", undo: null })}>{c.example}</button><button className="tool-icon-button" onClick={() => fileInput.current?.click()} title={c.importFile} aria-label={c.importFile}><FileUp /></button><button disabled={!draft.input} onClick={() => change(tool, { input: "", error: "", undo: draft.input })}>{c.clear}</button></div></div>
            <input type="file" ref={fileInput} className="sr-only" accept=".txt,.md,.json,.yaml,.yml,.toml,.xml,.sql,.ts,.js,.py,.java,.cpp,.cs,.vb,.log" onChange={async (event) => {
              const file = event.target.files?.[0]; const id = tool; const original = draftsRef.current[id].input; event.target.value = "";
              if (!file) return;
              if (file.size > 500_000) { toast.error(c.tooLarge); return; }
              try { const text = await file.text(); if (text.length > 120_000) { toast.error(c.tooLarge); return; } if (alive.current && draftsRef.current[id].input === original) change(id, { input: text, error: "", undo: original }); }
              catch { toast.error(c.fileFailed); }
            }} />
            <div className="tool-composer">
              <textarea id="tool-input" className={`tool-input ${tool === "format" ? "tool-code" : ""}`} spellCheck={false} maxLength={120_000} value={draft.input} onChange={(event) => change(tool, { input: event.target.value, error: "" })} onKeyDown={(event) => { if (event.ctrlKey && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void run(tool); } }} placeholder={tool === "naming" ? c.namingPlaceholder : tool === "diagnose" ? c.diagnosePlaceholder : tool === "regex" ? c.regexPlaceholder : c.sourcePlaceholder} />
              <div className="tool-composer-footer">
                <Tooltip><TooltipTrigger asChild><button className="tool-send-info" aria-label={c.currentInputOnly}><Info /><span>{c.currentInputOnly}</span></button></TooltipTrigger><TooltipContent>{c.sentHint}</TooltipContent></Tooltip>
                <div className="tool-run-row"><kbd title={c.enterHint} aria-label={c.runShortcut}>Ctrl ↵</kbd><Button className="tool-run-button" data-busy={job === tool} size="md" pressScale={0.985} whileHover={undefined} transition={{ type: "spring", stiffness: 600, damping: 49 }} disabled={Boolean(job) || !draft.input.trim() || !provider} onClick={() => { void run(tool); }}>{job === tool ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}<span className="tool-run-label"><span aria-hidden="true">{runLabel}</span><span>{job === tool ? c.working : runLabel}</span></span></Button></div>
              </div>
            </div>
            <div className="tool-input-status">
              {tool === "format" && <div className="tool-local" aria-live="polite">
                {syntax?.status === "invalid" ? <details key={tool}><summary className="tool-warning" title={c.diagnosticDetails}><TriangleAlert /><span>{c.syntaxSourceInvalid}</span></summary><pre className="tool-parser-error">{syntax.message}</pre></details> : <span>{syntax?.status === "valid" ? <CheckCheck /> : <Circle />}{!syntax ? c.noSource : syntax.status === "valid" ? c.syntaxValid : c.unchecked}</span>}
              </div>}
              {draft.undo !== null && <button className="tool-undo" onClick={() => change(tool, { input: draft.undo!, undo: null })}><RotateCcw />{c.undo}</button>}
              {job && job !== tool && <span className="tool-note">{c.waiting}</span>}
              {draft.error && <p role="alert" className="tool-error">{draft.error}</p>}
            </div>
          </section>
          <section className="tool-result-pane" aria-label={c.result} aria-busy={job === tool}>
            <div className="tool-result-label"><h3>{c.result}</h3>{job === tool && <span role="status"><LoaderCircle className="animate-spin" />{c.working}</span>}</div>
            <ToolResults key={tool} tool={tool} result={draft.result} stale={stale} c={c} copy={copy} apply={() => { change(tool, { input: draft.result!.text, undo: draft.input }); toast.success(c.applied); }} />
          </section>
        </div>
      </section>
    </div>
  </div>;
}
