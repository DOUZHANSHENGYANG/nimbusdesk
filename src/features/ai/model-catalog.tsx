import { useEffect, useId, useState } from "react";
import { Check, Plus, Search, Trash2, ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cleanModelId, getProviderModels, selectModel, type AiProvider, type ModelParameters, type ProviderModel } from "./core";
import { providerError, useProviderCopy } from "./provider-copy";

export function ModelCatalog({ provider, disabled, onChange, onValidityChange }: { provider: AiProvider; disabled: boolean; onChange: (provider: AiProvider) => void; onValidityChange: (valid: boolean) => void }) {
  const c = useProviderCopy();
  const id = useId();
  const [search, setSearch] = useState("");
  const [manual, setManual] = useState("");
  const [error, setError] = useState("");
  const [invalidFields, setInvalidFields] = useState<Record<string, boolean>>({});
  const [parameterEpoch, setParameterEpoch] = useState(0);
  const models = getProviderModels(provider);
  const matches = models.filter((model) => model.id.toLowerCase().includes(search.trim().toLowerCase()));
  const active = models.find((model) => model.id === provider.model);
  useEffect(() => { setInvalidFields({}); }, [provider.model]);
  useEffect(() => { onValidityChange(!Object.values(invalidFields).some(Boolean)); }, [invalidFields, onValidityChange]);
  useEffect(() => () => onValidityChange(true), [onValidityChange]);
  const update = (patch: Partial<ProviderModel>) => {
    if (!active) return;
    onChange({ ...provider, vision: patch.vision ?? active.vision, models: models.map((model) => model.id === active.id ? { ...model, ...patch } : model) });
  };
  function addModel() {
    try {
      const model = cleanModelId(manual);
      const next = models.some((item) => item.id === model) ? models : [...models, { id: model, vision: false }];
      onChange(selectModel({ ...provider, models: next }, model));
      setManual(""); setSearch(""); setError("");
    } catch (failure) { setError(providerError(failure, c)); }
  }
  function removeModel(modelId: string) {
    const next = models.filter((model) => model.id !== modelId);
    const selected = provider.model === modelId ? next[0] : next.find((model) => model.id === provider.model);
    onChange({ ...provider, model: selected?.id ?? "", vision: selected?.vision ?? false, models: next });
  }
  function parameter(key: keyof ModelParameters, value: string) {
    const parameters = { ...active?.parameters };
    if (!value) delete parameters[key];
    else if (key === "temperature" || key === "topP" || key === "maxTokens") parameters[key] = Number(value);
    else Object.assign(parameters, { [key]: value });
    update({ parameters });
  }
  return <div className="provider-models">
    <div className="provider-model-search"><Search aria-hidden="true" /><Input aria-label={c.searchModels} placeholder={c.searchModels} value={search} onChange={(event) => setSearch(event.target.value)} disabled={disabled} /><span>{models.length}</span></div>
    <div className="provider-model-list" aria-label={c.models}>
      {matches.slice(0, 100).map((model) => <div className="provider-model-row" key={model.id} data-selected={model.id === provider.model}>
        <button type="button" className="provider-model-select" disabled={disabled} aria-label={`${c.defaultModel}: ${model.id}`} aria-pressed={model.id === provider.model} onClick={() => onChange(selectModel(provider, model.id))}>
          <span className="provider-model-check">{model.id === provider.model && <Check />}</span><span className="provider-model-name">{model.id}</span>{model.vision && <ImageIcon className="size-3.5 shrink-0" aria-label={c.vision} />}{model.id === provider.model && <span className="provider-badge">{c.defaultBadge}</span>}
        </button><Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={`${c.removeModel}: ${model.id}`} onClick={() => removeModel(model.id)}><Trash2 className="size-3.5" /></Button>
      </div>)}
      {!matches.length && <p className="provider-empty-models">{models.length ? c.noMatches : c.noModels}</p>}
    </div>
    {matches.length > 100 && <p className="provider-help">{c.showing}</p>}
    <div className="provider-manual-model"><Input aria-label={c.modelId} placeholder={c.modelId} value={manual} disabled={disabled} onChange={(event) => setManual(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); addModel(); } }} /><Button type="button" variant="outline" disabled={disabled || !manual.trim()} onClick={addModel}><Plus className="size-3.5" />{c.addModel}</Button></div>
    {error && <p role="alert" className="provider-error">{error}</p>}
    {active && <div className="provider-model-options">
      <div className="provider-capability"><div><Label htmlFor={`${id}-vision`}>{c.vision}</Label><p className="provider-help">{c.visionHint}</p></div><Switch id={`${id}-vision`} checked={active.vision} disabled={disabled} onCheckedChange={(vision) => update({ vision })} /></div>
      <details className="provider-parameters"><summary>{c.parameters}<span className="provider-help">{active.id}</span></summary>
        <p className="provider-help">{c.parametersHint}</p><div className="provider-parameter-grid">
          {([{ key: "temperature", label: c.temperature, min: 0, max: 2, step: "any", exclusiveMin: false }, { key: "topP", label: c.topP, min: 0, max: 1, step: "any", exclusiveMin: true }, { key: "maxTokens", label: c.maxTokens, min: 1, max: 2000000, step: "1", exclusiveMin: false }] as const).map((field) => <div className="provider-field" key={`${active.id}-${field.key}-${parameterEpoch}`}><Label htmlFor={`${id}-${field.key}`}>{field.label}</Label><ParameterNumber id={`${id}-${field.key}`} min={field.min} max={field.max} step={field.step} exclusiveMin={field.exclusiveMin} placeholder={c.serviceDefault} value={active.parameters?.[field.key]} disabled={disabled} onValidity={(valid) => setInvalidFields((current) => ({ ...current, [field.key]: !valid }))} onChange={(value) => parameter(field.key, value)} /></div>)}
          <div className="provider-field"><Label htmlFor={`${id}-token-field`}>{c.tokenField}</Label><select id={`${id}-token-field`} value={active.parameters?.tokenLimitField ?? "max_tokens"} disabled={disabled} onChange={(event) => parameter("tokenLimitField", event.target.value)}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></div>
          <div className="provider-field"><Label htmlFor={`${id}-reasoning`}>{c.reasoning}</Label><select id={`${id}-reasoning`} value={active.parameters?.reasoningEffort ?? ""} disabled={disabled} onChange={(event) => parameter("reasoningEffort", event.target.value)}><option value="">{c.serviceDefault}</option>{["none", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
        </div>{Object.values(invalidFields).some(Boolean) && <p role="alert" className="provider-error">{c.invalid}</p>}<Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => { setInvalidFields({}); setParameterEpoch((value) => value + 1); update({ parameters: undefined }); }}>{c.resetParameters}</Button>
      </details>
    </div>}
  </div>;
}

function ParameterNumber({ value, onChange, onValidity, exclusiveMin, ...props }: { id: string; min: number; max: number; step: string; placeholder: string; disabled: boolean; exclusiveMin: boolean; value?: number; onChange: (value: string) => void; onValidity: (valid: boolean) => void }) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const allowedValue = (text: string) => text === "" || (Number.isFinite(Number(text)) && (exclusiveMin ? Number(text) > props.min : Number(text) >= props.min) && Number(text) <= props.max && (props.step !== "1" || Number.isInteger(Number(text))));
  const valid = allowedValue(text);
  useEffect(() => { setText((current) => value === undefined ? "" : current !== "" && Number(current) === value ? current : String(value)); }, [value]);
  return <Input {...props} type="number" aria-invalid={!valid} value={text} onChange={(event) => {
    const next = event.target.value; setText(next);
    const allowed = allowedValue(next);
    onValidity(allowed); if (allowed) onChange(next);
  }} />;
}
