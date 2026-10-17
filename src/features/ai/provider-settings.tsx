import { useCallback, useEffect, useId, useState } from "react";
import { Check, ChevronDown, Loader2, Plus, Server, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useModal } from "@/components/shell/modal-host";
import { useAiSettings } from "@/stores/ai";
import { cleanProvider, getProviderModels, type AiProvider } from "./core";
import { deleteSecret, saveSecret } from "./client";
import { migrateLegacySettings } from "./migration";
import { persistProviders, providersReady, useProviders } from "./providers";
import { ProviderEditor } from "./provider-editor";
import { providerError, useProviderCopy } from "./provider-copy";
import "./provider-settings.css";

const blank = (): AiProvider => ({ id: crypto.randomUUID(), name: "", baseUrl: "", model: "", vision: false, models: [] });

export function ProviderSettings({ onDirtyChange: notifyDirty }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const c = useProviderCopy();
  const modal = useModal();
  const fieldId = useId();
  const providers = useProviders((state) => state.providers);
  const defaultId = useProviders((state) => state.defaultTextId);
  const imageId = useProviders((state) => state.defaultVisionId);
  const imageModel = useProviders((state) => state.defaultVisionModel);
  const legacy = useAiSettings();
  const [ready, setReady] = useState(useProviders.persist.hasHydrated());
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newDraft, setNewDraft] = useState(blank);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = adding ? undefined : providers.find((provider) => provider.id === selected) ?? providers.find((provider) => provider.id === defaultId) ?? providers[0];
  const needsMigration = Boolean(legacy.llmBaseUrl && legacy.llmModel && (legacy.llmApiKey || !providers.some((provider) => provider.id === "legacy-news")));
  const onDirtyChange = useCallback((value: boolean) => { setDirty(value); notifyDirty?.(value); }, [notifyDirty]);

  useEffect(() => { let active = true; void providersReady().then(() => { if (active) setReady(true); }); return () => { active = false; }; }, []);
  useEffect(() => () => notifyDirty?.(false), [notifyDirty]);
  // Changing the app default must not replace the editor's unsaved connection.
  useEffect(() => { if (!adding && active && selected !== active.id) setSelected(active.id); }, [active, adding, selected]);
  async function allowSwitch() { return !dirty || await modal.confirm({ title: c.discardTitle, description: c.discardHint, confirmText: c.discard, cancelText: c.stay }); }
  async function choose(id: string | null) {
    if (id === active?.id && !adding) return;
    if (!await allowSwitch()) return;
    setDirty(false); setError(""); setSelected(id); setAdding(id === null);
    if (id === null) setNewDraft(blank());
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (failure) { setError(providerError(failure, c)); } finally { setBusy(false); }
  }
  async function save(provider: AiProvider, key: string, makeDefault: boolean) {
    const cleaned = cleanProvider(provider);
    if (key) await saveSecret(cleaned.id, key);
    useProviders.getState().saveProvider(cleaned);
    if (makeDefault) useProviders.getState().setDefault("text", cleaned.id);
    await persistProviders();
    setSelected(cleaned.id); setAdding(false);
  }
  async function remove() {
    if (!active || !await modal.confirm({ title: c.removeTitle, description: c.removeHint, confirmText: c.remove, danger: true })) return;
    const id = active.id;
    await run(async () => { await deleteSecret(id); useProviders.getState().removeProvider(id); await persistProviders(); setSelected(null); setAdding(false); setDirty(false); setNewDraft(blank()); });
  }
  const imageOptions = providers.flatMap((provider) => getProviderModels(provider).filter((model) => model.vision).map((model) => ({ provider, model })));
  const imageValue = imageId ? JSON.stringify([imageId, imageModel ?? providers.find((provider) => provider.id === imageId)?.model ?? ""]) : "";

  return <section className="provider-manager workbench-ui" aria-label={c.title}>
    <header className="provider-manager-heading"><div><h2>{c.title}</h2><p>{c.description}</p></div><Server className="provider-heading-icon" aria-hidden="true" /></header>
    {!ready ? <p className="provider-help"><Loader2 className="size-4 animate-spin" />{c.loading}</p> : <>
      <div className="provider-global-default"><div><label htmlFor={`${fieldId}-default`}>{c.global}</label><p className="provider-help">{c.defaultDescription}</p></div><div className="provider-default-select"><select id={`${fieldId}-default`} disabled={busy} value={defaultId ?? ""} onChange={(event) => { const id = event.target.value || null; void run(async () => { useProviders.getState().setDefault("text", id); await persistProviders(); }); }}><option value="">{c.unconfigured}</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}</select><ChevronDown aria-hidden="true" /></div></div>
      <details className="provider-image-override" open={imageId ? true : undefined}><summary>{c.imageOptions}</summary><p className="provider-help">{c.imageHint}</p><select aria-label={c.imageOptions} value={imageValue} disabled={busy} onChange={(event) => { const value = event.target.value; void run(async () => { if (!value) useProviders.getState().setVisionDefault(null, null); else { const [id, model] = JSON.parse(value) as [string, string]; useProviders.getState().setVisionDefault(id, model); } await persistProviders(); }); }}><option value="">{c.inherit}</option>{imageOptions.map(({ provider, model }) => <option key={`${provider.id}-${model.id}`} value={JSON.stringify([provider.id, model.id])}>{provider.name} · {model.id}</option>)}</select></details>
      {needsMigration && <div className="provider-migration"><div><strong>{c.migration}</strong><p className="provider-help">{c.migrationHint}</p></div><Button variant="outline" disabled={busy} onClick={() => void run(migrateLegacySettings)}>{c.migrate}</Button></div>}
      {error && <p role="alert" className="provider-error">{error}</p>}
      <div className="provider-workspace"><aside className="provider-sidebar"><div className="provider-sidebar-heading"><h3>{c.providers}</h3><span>{providers.length}</span></div>
        <Button variant="outline" className="provider-add" disabled={busy} onClick={() => void choose(null)}><Plus className="size-3.5" />{c.add}</Button>
        <div className="provider-connections">{providers.map((provider) => <div key={provider.id} className="provider-connection-row" data-selected={active?.id === provider.id}>
          <button type="button" disabled={busy} className="provider-connection-select" aria-label={`${c.configure}: ${provider.name}`} aria-pressed={active?.id === provider.id} onClick={() => void choose(provider.id)}><span className="provider-service-icon">{provider.name.slice(0, 1).toUpperCase()}</span><span><strong>{provider.name}</strong><small>{getProviderModels(provider).length} {c.modelCount}</small></span>{defaultId === provider.id && <span className="provider-badge">{c.defaultBadge}</span>}</button>
          {defaultId !== provider.id && <button type="button" disabled={busy} className="provider-set-default" aria-label={`${c.setDefault}: ${provider.name}`} title={c.setDefault} onClick={() => void run(async () => { useProviders.getState().setDefault("text", provider.id); await persistProviders(); })}><Star className="size-3.5" /></button>}
        </div>)}{adding && <div className="provider-pending-connection"><Plus className="size-3.5" />{c.newConnection}</div>}{!providers.length && <div className="provider-sidebar-empty"><Server /><p>{c.noProviders}</p><small>{c.noProvidersHint}</small></div>}</div>
        <div className="provider-shared-note"><Check />{c.description}</div>
      </aside><ProviderEditor key={active?.id ?? newDraft.id} initial={active ?? newDraft} existing={Boolean(active)} blocked={busy} onDirtyChange={onDirtyChange} onSave={save} onDelete={() => void remove()} /></div>
    </>}
  </section>;
}
