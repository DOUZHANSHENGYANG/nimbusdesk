import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Copy, Plug, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { copyText } from "@/lib/clipboard";
import { tbMcpDelete, tbMcpExport, tbMcpList, tbMcpSave, type TbMcpServer } from "./api";
import { ConfirmDialog } from "./confirm";
import { formatPairs, matchQuery, mcpNameProblem, parsePairs, timeLabel } from "./core";
import { TagEditor } from "./tag-input";
import "./toolbox.css";

const blank = (): TbMcpServer => ({
  id: "",
  name: "",
  description: "",
  transport: "stdio",
  command: "",
  args: [],
  env: {},
  url: "",
  headers: {},
  tags: [],
  enabled: true,
  origin: null,
  versions: [],
  createdAt: "",
  updatedAt: "",
});

export function McpView() {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<TbMcpServer[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  const [draft, setDraft] = useState<TbMcpServer | null>(null);
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [headerText, setHeaderText] = useState("");
  const [busy, setBusy] = useState(false);
  const [baseline, setBaseline] = useState("");
  const [pending, setPending] = useState<"delete" | { switch: TbMcpServer } | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await tbMcpList());
      setFailure("");
    } catch (error) {
      setFailure(String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(
    () => items.filter((item) => matchQuery(query, [item.name, item.description, item.tags])),
    [items, query],
  );
  // 「改动过没有」的判据是**整份对象的签名**：文本区里的 args/env 也要算进去，
  // 否则改了命令行参数却没有提示。新建（还没有 id）一律算未保存。
  const dirty = Boolean(draft) && (draft!.id === "" || signature(draft!, argsText, envText, headerText) !== baseline);

  function openItem(next: TbMcpServer) {
    const args = next.args.join("\n");
    const env = formatPairs(next.env);
    const headers = formatPairs(next.headers);
    setDraft({ ...next });
    setArgsText(args);
    setEnvText(env);
    setHeaderText(headers);
    setBaseline(signature(next, args, env, headers));
  }

  function select(next: TbMcpServer) {
    if (next.id === draft?.id && !dirty) return;
    if (dirty) { setPending({ switch: next }); return; }
    openItem(next);
  }

  async function save() {
    if (!draft) return;
    const problem = mcpNameProblem(draft.name);
    if (problem) {
      toast.error(problem === "empty" ? t("toolbox.mcp.nameEmpty") : t("toolbox.mcp.nameSeparator"));
      return;
    }
    setBusy(true);
    try {
      const stored = await tbMcpSave({
        ...draft,
        name: draft.name.trim(),
        args: parseArgs(argsText),
        env: parsePairs(envText),
        headers: parsePairs(headerText),
      });
      openItem(stored);
      await load();
      toast.success(t("toolbox.saved"));
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!draft) return;
    setPending(null);
    try {
      if (draft.id) await tbMcpDelete(draft.id);
      setDraft(null);
      await load();
      toast.success(t("toolbox.mcp.deleted"));
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function exportEnabled() {
    try {
      const payload = await tbMcpExport([]);
      const names = Object.keys(payload.mcpServers);
      if (names.length === 0) { toast.error(t("toolbox.mcp.exportEmpty")); return; }
      if (await copyText(JSON.stringify(payload, null, 2))) toast.success(t("toolbox.mcp.exported", { count: names.length }));
      else toast.error(t("toolbox.mcp.copyFailed"));
    } catch (error) {
      toast.error(String(error));
    }
  }

  const remote = (draft?.transport ?? "stdio") !== "stdio";

  return (
    <>
      <div className="toolbox-split">
        <div className="toolbox-column">
          <div className="toolbox-toolbar">
            <label className="toolbox-search">
              <Search />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("toolbox.searchMcp")} aria-label={t("toolbox.searchMcp")} />
            </label>
            <button type="button" className="toolbox-icon-button" title={t("toolbox.refresh")} aria-label={t("toolbox.refresh")} onClick={() => void load()}>
              <RefreshCw />
            </button>
          </div>
          <div className="toolbox-actions" style={{ marginBottom: 10 }}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => { const next = blank(); if (dirty) { setPending({ switch: next }); return; } openItem(next); }}
            >
              <Plus className="size-3.5" />
              {t("toolbox.mcp.new")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void exportEnabled()}>
              <Copy className="size-3.5" />
              {t("toolbox.mcp.export")}
            </Button>
          </div>
          <div className="toolbox-column toolbox-column-panel">
            {loading ? (
              <div className="toolbox-empty">{t("toolbox.loading")}</div>
            ) : items.length === 0 ? (
              <div className="toolbox-empty">
                <Plug />
                <span>{t("toolbox.mcp.empty")}</span>
              </div>
            ) : visible.length === 0 ? (
              <div className="toolbox-empty"><span>{t("toolbox.noMatch")}</span></div>
            ) : (
              <div className="toolbox-list">
                {visible.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="toolbox-row"
                    aria-current={draft?.id === item.id}
                    onClick={() => select(item)}
                  >
                    <span className="toolbox-row-head">
                      <strong>{item.name || t("toolbox.mcp.untitled")}</strong>
                      {!item.enabled && <span className="toolbox-badge">{t("toolbox.mcp.disabled")}</span>}
                    </span>
                    <p>{item.transport === "stdio" ? item.command : item.url}</p>
                    <span className="toolbox-row-meta">
                      <span>{item.transport}</span>
                      {item.origin?.harness && <><span>·</span><span>{item.origin.harness}</span></>}
                      <span>·</span>
                      <span>{timeLabel(item.updatedAt, i18n.language)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="toolbox-column toolbox-detail">
          {failure && <div className="toolbox-error">{failure}</div>}
          {!draft ? (
            <div className="toolbox-empty">
              <Plug />
              <span>{t("toolbox.mcp.pick")}</span>
            </div>
          ) : (
            <>
              <div className="toolbox-detail-head">
                <div>
                  <h2>{draft.name || t("toolbox.mcp.new")}</h2>
                  <code>{draft.id || t("toolbox.prompts.unsavedItem")}</code>
                </div>
                <div className="toolbox-actions">
                  <label className="toolbox-inline-switch">
                    <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} aria-label={t("toolbox.mcp.enabled")} />
                    {t("toolbox.mcp.enabled")}
                  </label>
                  {draft.id && (
                    <button type="button" className="toolbox-icon-button toolbox-danger" title={t("toolbox.delete")} aria-label={t("toolbox.delete")} onClick={() => setPending("delete")}>
                      <Trash2 />
                    </button>
                  )}
                </div>
              </div>

              <div className="toolbox-grid-2">
                <div className="toolbox-field">
                  <label htmlFor="tb-mcp-name">{t("toolbox.mcp.name")}</label>
                  <Input id="tb-mcp-name" value={draft.name} placeholder={t("toolbox.mcp.namePlaceholder")} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                </div>
                <div className="toolbox-field">
                  <label htmlFor="tb-mcp-desc">{t("toolbox.prompts.description")}</label>
                  <Input id="tb-mcp-desc" value={draft.description} placeholder={t("toolbox.mcp.descriptionPlaceholder")} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
                </div>
              </div>

              <div className="toolbox-field">
                <label>{t("toolbox.tags.title")}</label>
                <TagEditor value={draft.tags} onChange={(tags) => setDraft({ ...draft, tags })} />
              </div>

              <div className="toolbox-field">
                <label htmlFor="tb-mcp-transport">{t("toolbox.mcp.transport")}</label>
                <select id="tb-mcp-transport" value={draft.transport} onChange={(event) => setDraft({ ...draft, transport: event.target.value })}>
                  <option value="stdio">{t("toolbox.mcp.transportStdio")}</option>
                  <option value="http">{t("toolbox.mcp.transportHttp")}</option>
                  <option value="sse">{t("toolbox.mcp.transportSse")}</option>
                </select>
              </div>

              {!remote ? (
                <div className="toolbox-grid-2">
                  <div className="toolbox-field">
                    <label htmlFor="tb-mcp-command">{t("toolbox.mcp.command")}</label>
                    <Input id="tb-mcp-command" className="mono" value={draft.command} placeholder="npx" onChange={(event) => setDraft({ ...draft, command: event.target.value })} />
                  </div>
                  <div className="toolbox-field">
                    <label htmlFor="tb-mcp-args">
                      {t("toolbox.mcp.args")}
                      <em>{t("toolbox.mcp.argsHint")}</em>
                    </label>
                    <Textarea id="tb-mcp-args" className="mono" rows={3} spellCheck={false} value={argsText} onChange={(event) => setArgsText(event.target.value)} />
                  </div>
                </div>
              ) : (
                <div className="toolbox-field">
                  <label htmlFor="tb-mcp-url">{t("toolbox.mcp.url")}</label>
                  <Input id="tb-mcp-url" className="mono" value={draft.url} placeholder="https://" onChange={(event) => setDraft({ ...draft, url: event.target.value })} />
                </div>
              )}

              <div className="toolbox-grid-2">
                <div className="toolbox-field">
                  <label htmlFor="tb-mcp-env">
                    {t("toolbox.mcp.env")}
                    <em>{t("toolbox.mcp.pairsHint")}</em>
                  </label>
                  <Textarea id="tb-mcp-env" className="mono" rows={3} spellCheck={false} value={envText} onChange={(event) => setEnvText(event.target.value)} />
                </div>
                <div className="toolbox-field">
                  <label htmlFor="tb-mcp-headers">
                    {t("toolbox.mcp.headers")}
                    <em>{t("toolbox.mcp.pairsHint")}</em>
                  </label>
                  <Textarea id="tb-mcp-headers" className="mono" rows={3} spellCheck={false} value={headerText} onChange={(event) => setHeaderText(event.target.value)} />
                </div>
              </div>

              <div className="toolbox-actions">
                <Button size="sm" disabled={busy || !dirty} onClick={() => void save()}>{t("toolbox.save")}</Button>
                <span className="spacer" />
                <span className="toolbox-hint">{dirty ? t("toolbox.unsaved") : t("toolbox.savedState")}</span>
              </div>

              {draft.versions.length > 0 && (
                <div className="toolbox-field">
                  <label>{t("toolbox.versions")}</label>
                  <div className="toolbox-versions">
                    {[...draft.versions].reverse().map((version) => (
                      <div className="toolbox-version" key={version.v}>
                        <strong>v{version.v}</strong>
                        <time>{timeLabel(version.savedAt, i18n.language)}</time>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pending !== null}
        title={pending === "delete" ? t("toolbox.mcp.deleteTitle", { name: draft?.name ?? "" }) : t("toolbox.discardTitle")}
        body={pending === "delete" ? t("toolbox.mcp.deleteBody") : t("toolbox.discardBody")}
        confirmLabel={pending === "delete" ? t("toolbox.delete") : t("toolbox.discard")}
        danger={pending === "delete"}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending === "delete") { void remove(); return; }
          const next = pending && typeof pending === "object" ? pending.switch : null;
          setPending(null);
          if (next) openItem(next);
        }}
      />
    </>
  );
}

/** 命令行参数一行一个（与 env 同样的「整段粘贴」用法）。 */
function parseArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 用于「改动过没有」的整份签名（含文本区里的 args/env/headers）。 */
function signature(item: TbMcpServer, args: string, env: string, headers: string): string {
  return JSON.stringify({ ...item, args: parseArgs(args), env: parsePairs(env), headers: parsePairs(headers) });
}
