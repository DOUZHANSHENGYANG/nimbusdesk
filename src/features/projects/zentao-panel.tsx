import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Plus, RefreshCw, Link2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Field, ProjectSelect } from "./forms";
import { useProjects } from "./store";
import { useZentao } from "./zentao-store";
import { forgetZenSecret, getZenSecretStatus, syncZenConnection, testZenConnection, useZentaoRuntimeState } from "./zentao-controller";
import type { ZenConnection, ZenSecretStatus } from "./zentao-types";
import { useZenCopy } from "./zentao-copy";
import { ZenWriteSettings } from "./zentao-writeback-panel";

export function ZenConnectionsButton({ onClick }: { onClick: () => void }) {
  const c = useZenCopy(), busy = useZentaoRuntimeState(s => s.busy);
  const running = Object.values(busy).some(Boolean);
  return <Button variant="outline" onClick={onClick} aria-label={c.title}>{running ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Link2 />}<span>{running ? c.syncing : c.title}</span></Button>;
}

export function ZenPanel({ onClose }: { onClose: () => void }) {
  const c = useZenCopy(), connections = useZentao(s => s.connections);
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [selected, setSelected] = useState(connections[0]?.id ?? "");
  const connection = connections.find(value => value.id === selected) ?? connections[0];
  function add() { try { setSelected(useZentao.getState().addConnection({ name: `${c.noName} ${connections.length + 1}` })); } catch { toast.error(c.failed); } }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={event => { event.preventDefault(); returnFocus.current?.focus(); }}><DialogHeader><DialogTitle>{c.title}</DialogTitle><DialogDescription>{c.intro}</DialogDescription></DialogHeader>
    <div className="flex flex-wrap items-center gap-2"><div className="min-w-0 flex-1">{connections.length > 0 && <ProjectSelect label={c.title} value={connection?.id ?? ""} onChange={setSelected} options={connections.map(value => ({ value: value.id, label: value.name || c.noName }))} />}</div><Button variant="outline" onClick={add}><Plus />{c.add}</Button></div>
    {connection ? <ConnectionEditor key={connection.id} connection={connection} /> : <p className="py-8 text-center text-sm text-muted-foreground">{c.empty}</p>}
    <DialogFooter><Button variant="ghost" onClick={onClose}>{c.close}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function ConnectionEditor({ connection }: { connection: ZenConnection }) {
  const c = useZenCopy(), meta = useZentao(s => s.syncStates[connection.id]);
  const busy = useZentaoRuntimeState(s => Boolean(s.busy[connection.id]));
  const tasks = useProjects(s => s.remoteTasks), executions = useProjects(s => s.remoteExecutions);
  const locked = tasks.some(task => task.connectionId === connection.id);
  const [draft, setDraft] = useState(connection), [scope, setScope] = useState(connection.executionIds.join(", "));
  const [password, setPassword] = useState(""), [token, setToken] = useState("");
  const [secret, setSecret] = useState<ZenSecretStatus | null>(null), [error, setError] = useState(""), [testing, setTesting] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(connection) || scope !== connection.executionIds.join(", ");
  const ready = Boolean(connection.baseUrl && connection.account);
  useEffect(() => { let active = true; void getZenSecretStatus(connection.id).then(value => { if (active) setSecret(value); }).catch(() => {}); return () => { active = false; }; }, [connection.id]);
  function save(): boolean {
    const parts = scope.trim().split(/[,，\s]+/).filter(Boolean), ids = parts.map(Number);
    if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) { setError(c.scopeInvalid); return false; }
    try {
      const value = { ...draft, name: draft.name.trim() || c.noName, baseUrl: draft.baseUrl.trim(), account: draft.account.trim(), executionIds: [...new Set(ids)], syncMinutes: Math.max(1, Math.min(1440, draft.syncMinutes || 15)) };
      useZentao.getState().updateConnection(connection.id, value); setDraft({ ...value, ...useZentao.getState().connections.find(v => v.id === connection.id) }); setScope(value.executionIds.join(", ")); setError(""); return true;
    } catch { setError(c.failed); return false; }
  }
  async function test() {
    setError(""); if (!draft.baseUrl.trim() || !draft.account.trim()) return setError(c.required);
    if (!save()) return;
    setTesting(true);
    try { await testZenConnection(connection.id, password || undefined, token || undefined); setPassword(""); setToken(""); setSecret(await getZenSecretStatus(connection.id)); toast.success(c.tested); }
    catch (error) { setError(error instanceof Error ? error.message : c.failed); } finally { setTesting(false); }
  }
  async function sync() { setError(""); try { await syncZenConnection(connection.id); } catch { /* Persistent sync metadata shows the sanitized error. */ } }
  async function forget() { setError(""); try { await forgetZenSecret(connection.id); setPassword(""); setToken(""); setSecret({ hasPassword: false, hasToken: false }); } catch { setError(c.failed); } }
  async function remove() { setError(""); setTesting(true); try { await forgetZenSecret(connection.id); useZentao.getState().removeConnection(connection.id); } catch { setError(c.failed); } finally { setTesting(false); } }
  const disabled = busy || testing;
  return <div className="grid gap-4" data-zen-connection={connection.id}>
    <fieldset disabled={disabled} className="grid gap-3 disabled:opacity-70">
      <Field label={c.name}><Input value={draft.name} maxLength={300} aria-label={c.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field>
      <Field label={c.address}><Input type="url" value={draft.baseUrl} disabled={locked} placeholder="https://zentao.example.com/zentao/" aria-label={c.address} onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} /></Field>
      <div className="grid gap-3 sm:grid-cols-2"><Field label={c.account}><Input value={draft.account} disabled={locked} autoComplete="username" aria-label={c.account} onChange={e => setDraft({ ...draft, account: e.target.value })} /></Field><Field label={c.api}><ProjectSelect label={c.api} value={draft.apiVersion} onChange={v => setDraft({ ...draft, apiVersion: v as ZenConnection["apiVersion"] })} options={[{ value: "auto", label: c.auto }, { value: "v1", label: "API v1" }, { value: "v2", label: "API v2" }]} /></Field></div>
      {locked && <p className="text-xs leading-relaxed text-muted-foreground">{c.locked}</p>}
      <Field label={c.scope}><Input value={scope} inputMode="numeric" aria-label={c.scope} placeholder="12, 34" onChange={e => setScope(e.target.value)} /><span className="text-[11px] font-normal">{c.scopeHint}</span></Field>
      {executions.some(value => value.connectionId === connection.id) && <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto" aria-label={c.scope}>{executions.filter(value => value.connectionId === connection.id).map(value => { const selected = scope.split(/[,，\s]+/).map(Number).includes(value.remoteId); return <Button key={value.id} type="button" size="sm" variant={selected ? "secondary" : "ghost"} aria-pressed={selected} onClick={() => { const ids = scope.split(/[,，\s]+/).map(Number).filter(id => id > 0 && id !== value.remoteId); setScope([...ids, ...(!selected ? [value.remoteId] : [])].join(", ")); }}>{value.name} · #{value.remoteId}</Button>; })}</div>}
      <ZenWriteSettings value={draft.writeFields ?? []} onChange={writeFields => setDraft({ ...draft, writeFields })} />
      <div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-2 text-xs"><Switch checked={draft.autoSync} onCheckedChange={checked => setDraft({ ...draft, autoSync: checked })} aria-label={c.autoSync} />{c.autoSync}</label>{draft.autoSync && <Field label={c.interval}><Input className="w-24" type="number" min={1} max={1440} value={draft.syncMinutes} aria-label={c.interval} onChange={e => setDraft({ ...draft, syncMinutes: Number(e.target.value) })} /></Field>}<Button className="ml-auto" variant="outline" onClick={() => { if (save()) toast.success(c.saved); }}>{c.save}</Button></div>
    </fieldset>
    <div className="grid gap-3 border-t border-border pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{secret?.hasPassword || secret?.hasToken ? c.stored : c.noSecret}</span><Button size="sm" variant="ghost" disabled={disabled || !secret || !(secret.hasPassword || secret.hasToken)} onClick={() => void forget()}>{c.forget}</Button></div>
      <div className="grid gap-3 sm:grid-cols-2"><Field label={c.password}><Input type="password" value={password} autoComplete="new-password" disabled={disabled} aria-label={c.password} onChange={e => setPassword(e.target.value)} /></Field><Field label={c.token}><Input type="password" value={token} autoComplete="off" disabled={disabled} aria-label={c.token} onChange={e => setToken(e.target.value)} /></Field></div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{c.secretHint}</p><Button variant="outline" disabled={disabled} onClick={() => void test()}>{testing && <LoaderCircle className="animate-spin motion-reduce:animate-none" />}{c.test}</Button>
    </div>
    <div className="grid gap-2 rounded-lg border border-border p-3" aria-live="polite"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{meta?.lastSyncAt ? `${c.last} · ${new Date(meta.lastSyncAt).toLocaleString()} · ${meta.lastCount} ${c.count}` : ready ? c.never : c.draft}</p><Button size="sm" disabled={disabled || !ready || dirty} onClick={() => void sync()}>{busy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <RefreshCw />}{busy ? c.syncing : meta?.lastError ? c.retry : c.sync}</Button></div>{busy && <p role="status" className="text-xs text-muted-foreground">{c.background}</p>}{dirty && <p className="text-xs text-muted-foreground">{c.dirty}</p>}{meta?.authRequired && <p className="text-xs text-destructive">{c.auth}</p>}{meta?.lastError && <p role="alert" className="break-words text-xs text-destructive">{meta.lastError}</p>}</div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <Button className={cn("justify-self-start text-muted-foreground")} variant="ghost" size="sm" title={locked ? c.removeLocked : c.remove} disabled={disabled || locked} onClick={() => void remove()}>{c.remove}</Button>
  </div>;
}
