import { useEffect, useRef, useState } from "react";
import { RiArchiveLine, RiSettings3Line, RiSparklingLine, RiCloseLine, RiFileTextLine, RiCheckboxCircleLine } from "@remixicon/react";
import "./workspace.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { ProviderSettings } from "@/features/ai/provider-settings";
import { useProviders } from "@/features/ai/providers";
import { selectProvider, type AiProvider } from "@/features/ai/core";
import { organizeNotes, listTemplates, readNote } from "./api";
import { suggestOrganization, type OrganizeMaterial } from "./organize";
import { frontmatterRange, inferTags, normalizeTags, tagsFromContent } from "./metadata";
import { NoteMarkdown } from "./markdown";
import { useKnowledgeCopy } from "./copy";
import { useKnowledge } from "./store";
import { foldersForVault } from "./folders";
import type { ArchiveKind, KnowledgeNote, OrganizeSuggestion } from "./types";

const BUILTINS = [
  { id: "auto", label: "自动选择结构", body: "根据材料内容选择开发经验、可复用配方或资源收藏结构。给出清晰章节、可执行内容、证据和引用；无法确认的结论明确标记。" },
  { id: "experience", label: "开发经验 / 排错复盘", body: "# 标题\n## 背景与环境\n## 问题与现象\n## 原因分析\n## 解决步骤\n## 验证结果\n## 注意事项与参考资料" },
  { id: "recipe", label: "开发配方 / 操作步骤", body: "# 标题\n## 适用场景\n## 前置条件\n## 参数\n使用 {{参数名}} 表示可替换值\n## 操作步骤与命令\n## 验证方法\n## 失败处理" },
  { id: "resource", label: "资源收藏 / 阅读摘要", body: "# 标题\n## 来源\n## 适用场景\n## 核心要点\n## 使用方法\n## 局限与相关资料" },
];

function initialSuggestion(materials: OrganizeMaterial[]): OrganizeSuggestion {
  const first = materials[0];
  let existing: string[] = [];
  try { existing = tagsFromContent(first.note.content); } catch { /* Keep malformed source available for review. */ }
  return { title: first.capture.title, kind: "experience", tags: normalizeTags([...existing, ...inferTags(first.note.path, first.note.content)]), content: materials.map(({ capture, note }) => {
    let body = note.content;
    try { const range = frontmatterRange(body); if (range) body = body.slice(range.body); } catch { /* Keep malformed source available for review. */ }
    return materials.length > 1 ? `## ${capture.title}\n\n${body}` : body;
  }).join("\n\n") };
}

/** Shared by ordinary notes, captured materials and the floating capture panel. */
export function OrganizationWorkspace({ root, materials, onClose, onArchived }: { root: string; materials: OrganizeMaterial[]; onClose: () => void; onArchived: (note: KnowledgeNote) => void }) {
  const c = useKnowledgeCopy();
  const bindings = useKnowledge((state) => state.folderBindings);
  const folders = foldersForVault(bindings, root);
  const providerConfig = useProviders();
  const [setup, setSetup] = useState(false);
  const [templates, setTemplates] = useState<KnowledgeNote[]>([]);
  const [template, setTemplate] = useState("auto");
  const [suggestion, setSuggestion] = useState<OrganizeSuggestion>(() => initialSuggestion(materials));
  const [tags, setTags] = useState(suggestion.tags.join(", "));
  const [vision, setVision] = useState(false);
  let provider: AiProvider | undefined;
  try { provider = selectProvider(providerConfig, vision); } catch { /* Setup remains available when a default is missing. */ }
  const [busy, setBusy] = useState<"generate" | "archive" | null>(null);
  const [error, setError] = useState("");
  const [templateError, setTemplateError] = useState("");
  const [preview, setPreview] = useState(false);
  const mounted = useRef(true);
  const running = useRef(false);
  const [generated, setGenerated] = useState(false);
  useEffect(() => {
    mounted.current = true;
    void listTemplates(root).then((notes) => { if (mounted.current) setTemplates(notes); }).catch((failure) => { if (mounted.current) setTemplateError(String(failure)); });
    return () => { mounted.current = false; };
  }, [root]);
  function patch(values: Partial<OrganizeSuggestion>) { setSuggestion((old) => ({ ...old, ...values })); }
  async function generate() {
    if (running.current) return;
    if (!provider) { setSetup(true); return; }
    running.current = true; setBusy("generate"); setError("");
    try {
      const builtin = BUILTINS.find((item) => item.id === template);
      const content = builtin?.body ?? (await readNote(root, template)).content;
      if (content.length > 64_000) throw new Error("模板过大，请选择 64,000 字符以内的模板。");
      const fixedKind = ["experience", "recipe", "resource"].includes(template) ? template as ArchiveKind : undefined;
      const next = await suggestOrganization(root, materials, vision, { template: content, kind: fixedKind });
      if (fixedKind) next.kind = fixedKind;
      const range = frontmatterRange(next.content);
      if (range) next.content = next.content.slice(range.body);
      if (mounted.current) { setSuggestion(next); setTags(normalizeTags(next.tags).join(", ")); setGenerated(true); }
    } catch (failure) { if (mounted.current) setError(String(failure)); }
    finally { running.current = false; if (mounted.current) setBusy(null); }
  }
  async function archive() {
    if (running.current || !suggestion.title.trim() || !suggestion.content.trim()) return;
    running.current = true; setBusy("archive"); setError("");
    try {
      const result = await organizeNotes(root, { ...suggestion, tags: normalizeTags(tags.split(/[,，]/)), sources: materials.map(({note}) => ({path:note.path,fingerprint:note.fingerprint})) });
      if (mounted.current) onArchived(result);
    } catch (failure) { if (mounted.current) setError(String(failure)); }
    finally { running.current = false; if (mounted.current) setBusy(null); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && busy !== "archive") onClose(); }}><DialogContent data-organization-workspace="true" className="workbench-ui organization-sheet" showCloseButton={false} onEscapeKeyDown={(event) => { if (busy === "archive") event.preventDefault(); }} onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}>
    <DialogHeader className="organization-header">
      <div className="organization-heading"><span className="workbench-icon"><RiSparklingLine aria-hidden="true" /></span><div><DialogTitle>{c.manual}</DialogTitle><DialogDescription>{c.aiWorkspaceHint}</DialogDescription></div></div>
      <Button variant="ghost" size="icon" aria-label="Close" disabled={busy === "archive"} onClick={onClose}><RiCloseLine /></Button>
    </DialogHeader>
    <div className="organization-scroll">
      <div className="organization-material"><div><span className="workbench-eyebrow">{c.sourceMaterials} · {String(materials.length).padStart(2, "0")}</span><p title={materials.map(({ capture }) => capture.title).join(" · ")}>{materials.map(({ capture }) => capture.title).join(" · ")}</p></div><Button size="sm" variant="ghost" onClick={() => setSetup((old) => !old)} title={provider ? `${provider.name} · ${provider.model}` : undefined}><RiSettings3Line className="size-3.5" />{provider ? provider.name : c.configureAI}</Button></div>
      {setup && <div className="organization-provider-setup"><ProviderSettings /></div>}
      {!provider && <p className="organization-hint">{c.aiProviderNeeded}</p>}
      <div className="organization-template">
        <label className="workbench-field"><span>{c.documentTemplate}</span><select value={template} disabled={!!busy} onChange={(event) => { setTemplate(event.target.value); setGenerated(false); }}><optgroup label={c.builtInTemplates}>{BUILTINS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</optgroup>{templates.length > 0 && <optgroup label={c.vaultTemplates}>{templates.map((item) => <option key={item.path} value={item.path}>{item.title}</option>)}</optgroup>}</select></label>
        <Button disabled={!!busy} onClick={() => void generate()}><RiSparklingLine className={busy === "generate" ? "animate-pulse" : ""} />{busy === "generate" ? c.aiBusy : generated ? c.regenerate : c.generateDocument}</Button>
      </div>
      <p className="organization-hint">{c.generateHint}</p>
      {templateError && <p className="organization-hint text-warning">{c.templateReadFailed}: {templateError}</p>}
      {materials.some(({ capture }) => capture.attachments.length > 0) && <div className="organization-attachments"><div className="organization-attachments-names">{materials.flatMap(({ capture }) => capture.attachments).map((image) => <span key={image.path} title={image.path}>{image.name}</span>)}</div><label><Checkbox checked={vision} onCheckedChange={(value) => setVision(value === true)} disabled={!!busy} />{c.sendImages}</label><p className="organization-hint">{c.imageNameContext}</p></div>}
      {error && <p role="alert" className="workbench-notice mt-4 break-words text-destructive">{error}</p>}
      <section className="organization-output">
        <h3 className="organization-section-heading">{generated ? <RiCheckboxCircleLine aria-hidden="true" /> : <RiFileTextLine aria-hidden="true" />}{c.archiveReview}</h3>
        <fieldset disabled={!!busy} className="organization-fields disabled:opacity-70">
          <label className="workbench-field"><span>{c.titleField}</span><Input value={suggestion.title} onChange={(event) => patch({ title: event.target.value })} /></label>
          <div className="organization-metadata"><label className="workbench-field"><span>{c.targetCategory}</span><select aria-label={c.targetCategory} value={suggestion.kind} onChange={(event) => patch({ kind: event.target.value as ArchiveKind })}>{(["experience", "recipe", "resource"] as const).map((kind) => <option key={kind} value={kind}>{c[kind]}</option>)}</select></label><label className="workbench-field"><span>{c.tags}</span><Input value={tags} onChange={(event) => setTags(event.target.value)} /></label></div>
          <p className="organization-target">{c.target}: {folders[suggestion.kind]}/</p>
          <div className="organization-content-toolbar"><span>{c.content}</span><Button type="button" variant="ghost" size="sm" onClick={() => setPreview((old) => !old)}>{preview ? c.edit : c.preview}</Button></div>
          {preview ? <div className="organization-preview"><NoteMarkdown root={root} path={materials[0].note.path} content={suggestion.content} onError={setError} /></div> : <Textarea aria-label={c.organizedContent} value={suggestion.content} onChange={(event) => patch({ content: event.target.value })} />}
        </fieldset>
      </section>
    </div>
    <footer className="organization-footer"><p>{generated ? c.aiReviewBeforeArchive : c.manualBeforeAI}</p><div><Button variant="ghost" disabled={busy === "archive"} onClick={onClose}>{c.cancelled}</Button><Button disabled={!!busy || !suggestion.title.trim() || !suggestion.content.trim()} onClick={() => void archive()}><RiArchiveLine />{busy === "archive" ? c.archiving : c.archive}</Button></div></footer>
  </DialogContent></Dialog>;
}
