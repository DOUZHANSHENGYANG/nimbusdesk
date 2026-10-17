import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle2, CircleDot, KeyRound, Loader2, RefreshCw, Server } from "lucide-react";
import { useModal } from "@/components/shell/modal-host";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cleanConnection, cleanProvider, type AiProvider } from "./core";
import { deleteSecret, fetchModels, hasSecret, testProvider } from "./client";
import { discoverModels, mergeDiscoveredModels, normalizeBaseUrl, PROVIDER_PRESETS } from "./setup";
import { ModelCatalog } from "./model-catalog";
import { providerError, useProviderCopy } from "./provider-copy";

export function ProviderEditor({ initial, existing, blocked, onDirtyChange, onSave, onDelete }: {
  initial: AiProvider; existing: boolean; blocked: boolean; onDirtyChange: (dirty: boolean) => void;
  onSave: (provider: AiProvider, key: string, makeDefault: boolean) => Promise<void>; onDelete: () => void;
}) {
  const c = useProviderCopy();
  const modal = useModal();
  const id = useId();
  const [draft, setDraft] = useState(() => structuredClone(initial));
  const [started, setStarted] = useState(existing || Boolean(initial.baseUrl));
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial));
  const savedBase = useRef(initial.baseUrl);
  const [key, setKey] = useState("");
  const [credential, setCredential] = useState<boolean | null>(null);
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | "key" | null>(null);
  const [fetching, setFetching] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [discoveryStatus, setDiscoveryStatus] = useState("");
  const [discoveryError, setDiscoveryError] = useState("");
  const [parametersValid, setParametersValid] = useState(true);
  const revision = useRef(0);
  const lastAttempt = useRef("");
  const currentDraft = useRef(draft); currentDraft.current = draft;
  const discoverRef = useRef<() => void>(() => {});
  const pending = blocked || busy !== null;
  const endpointMatches = normalizeBaseUrl(draft.baseUrl) === normalizeBaseUrl(savedBase.current);
  const useStoredKey = credential === true && endpointMatches;
  const credentialChangedHost = existing && credential !== false && !endpointMatches && !key;
  const dirty = Boolean(key) || JSON.stringify(draft) !== baseline || !parametersValid;

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    let active = true;
    void hasSecret(initial.id).then((saved) => { if (active) setCredential(saved); }).catch(() => { if (active) setCredential(null); });
    return () => { active = false; revision.current++; };
  }, [initial.id]);

  function change(provider: AiProvider) { setDraft(provider); setStatus(""); setError(""); }
  async function discover() {
    if (pending || credentialChangedHost) return;
    const input = currentDraft.current;
    const current = ++revision.current;
    lastAttempt.current = JSON.stringify([input.id, normalizeBaseUrl(input.baseUrl), key, useStoredKey]);
    setFetching(true); setDiscoveryStatus(""); setDiscoveryError("");
    try {
      const result = await discoverModels(input, (connection) => fetchModels(connection, key, useStoredKey));
      if (current !== revision.current) return;
      if (useStoredKey) savedBase.current = result.baseUrl;
      lastAttempt.current = JSON.stringify([input.id, result.baseUrl, key, useStoredKey]);
      setDraft((value) => {
        const models = mergeDiscoveredModels(value, result.models);
        const selected = value.model || (models.length === 1 ? models[0].id : "");
        return { ...value, baseUrl: result.baseUrl, models, model: selected, vision: models.find((model) => model.id === selected)?.vision ?? false };
      });
      setDiscoveryStatus(`${c.discovered} · ${result.models.length}`);
    } catch (failure) { if (current === revision.current) setDiscoveryError(providerError(failure, c, true)); }
    finally { if (current === revision.current) setFetching(false); }
  }
  discoverRef.current = () => { void discover(); };

  useEffect(() => {
    revision.current++;
    setFetching(false); setDiscoveryStatus(""); setDiscoveryError("");
    if (!auto || pending || credentialChangedHost) return;
    let baseUrl: string;
    try { baseUrl = cleanConnection({ id: draft.id, baseUrl: normalizeBaseUrl(draft.baseUrl) }).baseUrl; } catch { return; }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname);
    if (!key && !useStoredKey && !local) return;
    const signature = JSON.stringify([draft.id, baseUrl, key, useStoredKey]);
    if (lastAttempt.current === signature) return;
    const timer = window.setTimeout(() => discoverRef.current(), 1200);
    return () => { window.clearTimeout(timer); revision.current++; };
  }, [auto, draft.id, draft.baseUrl, key, useStoredKey, credentialChangedHost, pending]);

  async function preset(preset: typeof PROVIDER_PRESETS[number]) {
    if (dirty && !await modal.confirm({ title: c.discardTitle, description: c.presetReplace, confirmText: c.discard, cancelText: c.stay })) return;
    revision.current++;
    const provider = { id: draft.id, name: preset.id === "custom" ? "" : preset.name, baseUrl: preset.baseUrl, model: "", vision: false, models: [] };
    setStarted(true); setKey(""); change(provider); lastAttempt.current = "";
  }
  async function save(makeDefault: boolean) {
    if (pending || !parametersValid) return;
    if (!draft.model) { setError(c.missingModel); return; }
    if (credentialChangedHost) { setError(c.endpointChanged); return; }
    setBusy("save"); setError(""); setStatus("");
    try {
      const connection = cleanConnection({ id: draft.id, baseUrl: normalizeBaseUrl(draft.baseUrl) });
      const provider = cleanProvider({ ...draft, ...connection, name: draft.name.trim() || new URL(connection.baseUrl).hostname });
      await onSave(provider, key, makeDefault);
      savedBase.current = provider.baseUrl;
      const savedCredential = key ? true : credential;
      lastAttempt.current = JSON.stringify([provider.id, provider.baseUrl, "", savedCredential === true]);
      setDraft(provider); setBaseline(JSON.stringify(provider)); setKey(""); setCredential(savedCredential); setStatus(c.saved);
    } catch (failure) { setError(providerError(failure, c)); }
    finally { setBusy(null); }
  }
  async function test() {
    if (pending || !parametersValid) return;
    setBusy("test"); setError(""); setStatus("");
    try { const connection = cleanConnection({ id: draft.id, baseUrl: normalizeBaseUrl(draft.baseUrl) }); await testProvider(cleanProvider({ ...draft, ...connection, name: draft.name.trim() || new URL(connection.baseUrl).hostname }), key, useStoredKey); setStatus(c.connected); }
    catch (failure) { setError(providerError(failure, c)); }
    finally { setBusy(null); }
  }
  async function removeKey() {
    setBusy("key"); setError("");
    try { await deleteSecret(draft.id); setCredential(false); setStatus(c.keyDeleted); }
    catch (failure) { setError(providerError(failure, c)); }
    finally { setBusy(null); }
  }

  return <form className="provider-editor" onSubmit={(event) => { event.preventDefault(); void save(false); }}>
    {!existing && <section className="provider-presets"><h3>{c.presetTitle}</h3><p className="provider-help">{c.presetHint}</p><div className="provider-preset-grid">{PROVIDER_PRESETS.map((item) => <button type="button" key={item.id} disabled={pending} onClick={() => void preset(item)}><Server className="size-3.5" /><span>{item.id === "custom" ? c.custom : item.name}</span></button>)}</div></section>}
    {started && <>
    <section className="provider-connection"><div className="provider-section-heading"><h3>{c.connection}</h3><span className="provider-help">{dirty ? c.dirty : c.clean}</span></div>
      <div className="provider-field"><Label htmlFor={`${id}-name`}>{c.name}</Label><Input id={`${id}-name`} disabled={pending} value={draft.name} placeholder={c.unnamed} onChange={(event) => change({ ...draft, name: event.target.value })} /></div>
      <div className="provider-field"><Label htmlFor={`${id}-base`}>{c.base}</Label><Input id={`${id}-base`} disabled={pending} value={draft.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => change({ ...draft, baseUrl: event.target.value })} /><p className="provider-help">{c.baseHint}</p></div>
      <div className="provider-field"><div className="provider-key-heading"><Label htmlFor={`${id}-key`}>{c.key}</Label><span><KeyRound aria-hidden="true" />{credential === null ? c.keyUnknown : credential ? c.keySaved : c.keyAbsent}</span></div><Input id={`${id}-key`} type="password" autoComplete="new-password" disabled={pending} value={key} placeholder={credential ? "••••••••" : undefined} onChange={(event) => { setKey(event.target.value); setStatus(""); }} /><p className="provider-help">{c.keyHint}</p>{credentialChangedHost && <p className="provider-error" role="alert">{c.endpointChanged}</p>}</div>
    </section>
    <section className="provider-model-section"><div className="provider-section-heading"><h3>{c.models}</h3><div className="provider-discovery-actions"><Label htmlFor={`${id}-auto`}>{c.auto}</Label><Switch id={`${id}-auto`} checked={auto} disabled={pending} onCheckedChange={setAuto} /><Button type="button" variant="outline" size="sm" disabled={pending || fetching || !draft.baseUrl.trim() || credentialChangedHost} onClick={() => void discover()}>{fetching ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}{fetching ? c.discovering : c.discover}</Button></div></div>
      <p className="provider-help">{c.modelHint}</p><p className="provider-help">{c.autoHint}</p>
      {discoveryStatus && <p role="status" className="provider-success">{discoveryStatus}</p>}{discoveryError && <p role="alert" className="provider-error">{discoveryError} {c.manualHint}</p>}
      <ModelCatalog provider={draft} disabled={pending} onChange={change} onValidityChange={setParametersValid} />
    </section>
    <footer className="provider-editor-footer"><div className="provider-editor-status">{status ? <span role="status" className="provider-success"><CheckCircle2 />{status}</span> : <span className="provider-help"><CircleDot />{dirty ? c.dirty : c.clean}</span>}{error && <p role="alert" className="provider-error">{error}</p>}</div>
      <div className="provider-save-actions"><Button type="button" variant="outline" disabled={pending || !draft.model || !parametersValid || credentialChangedHost} onClick={() => void test()}>{busy === "test" ? <Loader2 className="size-3.5 animate-spin" /> : null}{c.test}</Button><Button type="submit" disabled={pending || !parametersValid || credentialChangedHost}>{busy === "save" ? <Loader2 className="size-3.5 animate-spin" /> : null}{c.save}</Button><Button type="button" variant="outline" disabled={pending || !parametersValid || credentialChangedHost} onClick={() => void save(true)}>{c.saveDefault}</Button></div>
      <div className="provider-danger-actions">{credential && <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => void removeKey()}>{c.deleteKey}</Button>}{existing && <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onDelete}>{c.remove}</Button>}</div>
    </footer>
    </>}
  </form>;
}
