import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Braces, Check, Copy, ListChecks, Plus, RefreshCw, ScanSearch, Server, Trash2 } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { tbMcpDelete, tbMcpList, tbMcpSave, type TbMcpServer } from "./api";
import { collectTags, matchQuery, matchTags, mcpExport, mcpNameProblem, parseMcpJson, type TagMode } from "./core";
import { ConfirmDialog } from "./confirm";
import { ToolboxPage } from "./page";
import { EmptyState } from "./shared/empty-state";
import { Field, Input, Textarea } from "./shared/form";
import { KeyValueEditor, recordFromRows, rowsFromRecord, type KvRow } from "./shared/key-value-editor";
import { FilterBar, SearchBar } from "./shared/search-bar";
import { TagFilter } from "./shared/tag-filter";
import { TagInput } from "./shared/tag-input";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./shared/dialog";
import "./toolbox.css";

const TRANSPORTS = ["stdio", "http", "sse"] as const;

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

/**
 * MCP 服务页。
 *
 * 与源侧的差异（都是后端缺口，不自己造）：
 * - 没有「测试连通性」：那会真的起 `npx xxx` 子进程，源侧有、云台明确不做。
 * - 没有「AI 打标签」：属于 AI 摘要/审查那条独立工作流。
 * - 卡片上没有「已分发到哪些工具」的角标：云台不维护 `targets` 状态，
 *   要说得准得先跑一次全机扫描（在「本机工具」页做），这里只显示来源。
 * - 编辑弹窗的 JSON 页只做「粘贴 → 解析成表单」：源侧还有「打开 JSON 文件 /
 *   从剪贴板粘贴」两个按钮，前者需要一条读文本文件的命令，后者在文本框里
 *   Ctrl+V 本来就能做。
 */
export function McpPage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<TbMcpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");

  const [query, setQuery] = useState("");
  const [transportFilter, setTransportFilter] = useState("all");
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [tagMode, setTagMode] = useState<TagMode>("or");

  const [batchMode, setBatchMode] = useState(false);
  const [batchSel, setBatchSel] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<TbMcpServer | null>(null);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);

  const [draft, setDraft] = useState<TbMcpServer | null>(null);
  const [saved, setSaved] = useState<TbMcpServer | null>(null);
  const [busy, setBusy] = useState(false);
  /** 编辑弹窗的两种方式：表单 / JSON */
  const [editorTab, setEditorTab] = useState<"manual" | "json">("manual");
  const [jsonText, setJsonText] = useState("");

  // 表单里用文本编辑的部分（参数一行一个、键值对一行一条）
  const [argsText, setArgsText] = useState("");
  const [envRows, setEnvRows] = useState<KvRow[]>([]);
  const [headerRows, setHeaderRows] = useState<KvRow[]>([]);

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

  useEffect(() => {
    void load();
  }, [load]);

  const { tags: allTags, counts: tagCounts } = useMemo(() => collectTags(items), [items]);

  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          (transportFilter === "all" || item.transport === transportFilter) &&
          matchTags(item.tags, activeTags, tagMode) &&
          matchQuery(query, [item.name, item.description, item.tags, item.command, item.url]),
      ),
    [items, query, transportFilter, activeTags, tagMode],
  );

  const dirty = useMemo(() => {
    if (!draft) return false;
    // 新建时「还没填」不算改动，否则一打开弹窗就写着「有未保存的改动」
    if (!saved) return Boolean(draft.name.trim() || draft.command.trim() || draft.url.trim());
    return JSON.stringify(draft) !== JSON.stringify(saved);
  }, [draft, saved]);

  function edit(patch: Partial<TbMcpServer>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function openEditor(server: TbMcpServer | null) {
    const base = server && server.id ? server : null;
    const next = base ? { ...base } : blank();
    setSaved(base);
    setDraft(next);
    setArgsText(next.args.join("\n"));
    setEnvRows(rowsFromRecord(next.env));
    setHeaderRows(rowsFromRecord(next.headers));
    setEditorTab("manual");
    setJsonText("");
  }

  async function persist(server: TbMcpServer) {
    const problem = mcpNameProblem(server.name);
    if (problem) {
      toast.error(problem === "empty" ? t("toolbox.mcp.nameEmpty") : t("toolbox.mcp.nameSeparator"));
      return null;
    }
    setBusy(true);
    try {
      const stored = await tbMcpSave({ ...server, name: server.name.trim(), description: server.description.trim() });
      await load();
      toast.success(t("toolbox.saved"));
      return stored;
    } catch (error) {
      toast.error(String(error));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!draft) return;
    // 文本式字段在提交这一刻才折回数组/字典：编辑过程中不打断输入
    const stored = await persist({
      ...draft,
      args: argsText.split("\n").map((line) => line.trim()).filter(Boolean),
      env: recordFromRows(envRows),
      headers: recordFromRows(headerRows),
    });
    if (stored) {
      setSaved(stored);
      setDraft({ ...stored });
    }
  }

  function importJson() {
    const parsed = parseMcpJson(jsonText);
    if (parsed.length === 0) {
      toast.error(t("toolbox.mcp.jsonBad"));
      return;
    }
    // 名字对得上就取那一条，否则取第一条；多条时如实告诉用户取了几条
    const picked = parsed.find((entry) => entry.name === draft?.name.trim()) ?? parsed[0];
    edit({
      name: picked.name,
      transport: picked.transport,
      command: picked.command,
      args: picked.args,
      env: picked.env,
      url: picked.url,
      headers: picked.headers,
    });
    setArgsText(picked.args.join("\n"));
    setEnvRows(rowsFromRecord(picked.env));
    setHeaderRows(rowsFromRecord(picked.headers));
    setEditorTab("manual");
    toast.success(parsed.length > 1 ? t("toolbox.mcp.jsonPicked", { name: picked.name, count: parsed.length }) : t("toolbox.mcp.jsonFilled"));
  }

  async function remove() {
    const target = deleting;
    setDeleting(null);
    if (!target?.id) return;
    try {
      await tbMcpDelete(target.id);
      if (saved?.id === target.id) {
        setDraft(null);
        setSaved(null);
      }
      await load();
      toast.success(t("toolbox.mcp.deleted"));
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function removeBatch() {
    const targets = items.filter((item) => batchSel.has(item.id));
    setBatchDeleteOpen(false);
    try {
      for (const target of targets) await tbMcpDelete(target.id);
      setBatchSel(new Set());
      await load();
      toast.success(t("toolbox.mcp.deleted"));
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function copyJson(list: TbMcpServer[]) {
    const payload = mcpExport(list);
    const count = Object.keys(payload.mcpServers).length;
    if (count === 0) {
      toast.error(t("toolbox.mcp.exportEmpty"));
      return;
    }
    if (await copyText(JSON.stringify(payload, null, 2))) toast.success(t("toolbox.mcp.exported", { count }));
    else toast.error(t("toolbox.mcp.copyFailed"));
  }

  const toggleBatch = (id: string) =>
    setBatchSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <ToolboxPage
      section="mcp"
      actions={
        <>
          <SearchBar value={query} onChange={setQuery} placeholder={t("toolbox.searchMcp")} className="w-56" />
          <Select value={transportFilter} onValueChange={setTransportFilter}>
            <SelectTrigger className="h-8 w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("toolbox.all")}</SelectItem>
              {TRANSPORTS.map((transport) => (
                <SelectItem key={transport} value={transport}>
                  {transport}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="secondary" className="h-8" disabled={items.length === 0} onClick={() => void copyJson(items.filter((item) => item.enabled))}>
            <Copy className="size-3.5" />
            {t("toolbox.mcp.export")}
          </Button>
          <Button size="sm" variant="secondary" className="h-8" onClick={() => void load()}>
            <RefreshCw className="size-3.5" />
            {t("toolbox.refresh")}
          </Button>
          <Button size="sm" className="h-8" onClick={() => openEditor(null)}>
            <Plus className="size-3.5" />
            {t("toolbox.mcp.new")}
          </Button>
        </>
      }
    >
      <FilterBar>
        <TagFilter
          allTags={allTags}
          selected={activeTags}
          onChange={setActiveTags}
          mode={tagMode}
          onModeChange={setTagMode}
          searchable
          counts={tagCounts}
          hideWhenEmpty={false}
          className="mb-0"
        />
      </FilterBar>

      {failure ? <div className="toolbox-error">{failure}</div> : null}

      {filtered.length > 0 ? (
        <div data-anim className="mb-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={batchMode ? "primary" : "secondary"}
            className="h-8"
            onClick={() => {
              setBatchMode((value) => !value);
              setBatchSel(new Set());
            }}
          >
            <ListChecks className="size-3.5" />
            {batchMode ? t("toolbox.mcp.batchExit") : t("toolbox.mcp.batchEnter")}
          </Button>
          {batchMode ? (
            <>
              <span className="text-[11px] text-ink-3">{t("toolbox.mcp.batchHint", { n: batchSel.size })}</span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-8"
                  disabled={batchSel.size === 0}
                  onClick={() => void copyJson(filtered.filter((item) => batchSel.has(item.id)))}
                >
                  <Copy className="size-3.5" />
                  {t("toolbox.mcp.batchCopyJson")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-8"
                  onClick={() =>
                    setBatchSel((prev) => (prev.size === filtered.length ? new Set() : new Set(filtered.map((item) => item.id))))
                  }
                >
                  {batchSel.size === filtered.length ? t("toolbox.mcp.unselectAll") : t("toolbox.selectAll")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-8 text-danger hover:bg-danger/10 hover:text-danger"
                  disabled={batchSel.size === 0}
                  onClick={() => setBatchDeleteOpen(true)}
                >
                  <Trash2 className="size-3.5" />
                  {t("toolbox.mcp.batchDelete")}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <div className="toolbox-empty">{t("toolbox.loading")}</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Server}
          title={items.length === 0 ? t("toolbox.mcp.empty") : t("toolbox.noMatch")}
          hint={items.length === 0 ? t("toolbox.mcp.emptyHint") : undefined}
          action={
            items.length === 0 ? (
              <Button size="sm" variant="secondary" onClick={() => openEditor(null)}>
                <Plus className="size-3.5" />
                {t("toolbox.mcp.new")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-3 pb-2 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((item) => (
            <div
              key={item.id}
              data-anim
              onClick={() => batchMode && toggleBatch(item.id)}
              onDoubleClick={() => !batchMode && openEditor(item)}
              className={cn(
                "group flex flex-col rounded-xl border border-border bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md",
                !item.enabled && "opacity-60",
                batchMode && "cursor-pointer",
                batchMode && batchSel.has(item.id) && "border-primary shadow-[0_0_0_3px_var(--ring)]",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-foreground">{item.name}</h3>
                {batchMode ? (
                  <span
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded border",
                      batchSel.has(item.id) ? "border-primary bg-primary text-primary-foreground" : "border-border-strong",
                    )}
                  >
                    {batchSel.has(item.id) ? <Check className="size-3.5" strokeWidth={3} /> : null}
                  </span>
                ) : item.enabled ? (
                  <Badge variant="secondary">{item.transport}</Badge>
                ) : (
                  <Badge variant="outline">{t("toolbox.mcp.disabled")}</Badge>
                )}
              </div>
              {item.description ? <p className="mt-1 line-clamp-1 text-xs text-ink-2">{item.description}</p> : null}
              <div className="mt-2 truncate rounded-md bg-bg-subtle px-2 py-1.5 font-mono text-[11px] text-ink-2" dir="ltr">
                {item.transport === "stdio" ? `${item.command} ${item.args.join(" ")}`.trim() || "—" : item.url || "—"}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1">
                {item.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
                {item.origin ? (
                  <Badge variant="outline" title={item.origin.file}>
                    {t("toolbox.mcp.origin")}: {item.origin.harness}
                  </Badge>
                ) : null}
              </div>
              <div className="mt-auto flex flex-wrap items-center justify-end gap-0.5 pt-3">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  title={t("toolbox.mcp.copyJson")}
                  aria-label={t("toolbox.mcp.copyJson")}
                  onClick={(event) => {
                    event.stopPropagation();
                    void copyJson([item]);
                  }}
                >
                  <Copy className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 px-2.5 text-[11px]"
                  onClick={(event) => {
                    event.stopPropagation();
                    openEditor(item);
                  }}
                >
                  {t("toolbox.edit")}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 hover:text-destructive"
                  title={t("toolbox.delete")}
                  aria-label={t("toolbox.delete")}
                  onClick={(event) => {
                    event.stopPropagation();
                    setDeleting(item);
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={draft !== null} onOpenChange={(open) => { if (!open) { setDraft(null); setSaved(null); } }}>
        <DialogContent className="flex max-h-[88vh] flex-col gap-3 sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{saved ? t("toolbox.mcp.editTitle") : t("toolbox.mcp.newTitle")}</DialogTitle>
            {/* 表单 / JSON 两种填法始终可用 —— 已经有服务时也应能直接粘一段 JSON 覆盖。
                用源侧那套 beUI 页签：药丸会从一格弹到另一格，文字在两格之间裁切过渡。 */}
            <Tabs
              value={editorTab}
              onValueChange={(value) => setEditorTab(value as "manual" | "json")}
              variant="segment"
              className="w-fit"
            >
              <TabsList>
                <TabsTrigger value="manual" className="px-3 py-1 text-[11px]">
                  {t("toolbox.mcp.tabManual")}
                </TabsTrigger>
                <TabsTrigger value="json" className="px-3 py-1 text-[11px]">
                  {t("toolbox.mcp.tabJson")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </DialogHeader>

          <DialogBody className="flex flex-col gap-4">
            {editorTab === "json" ? (
              <>
                <p className="rounded-lg bg-bg-subtle px-3 py-2.5 text-xs leading-relaxed text-ink-2">{t("toolbox.mcp.jsonExplain")}</p>
                <Field label="JSON">
                  <Textarea
                    value={jsonText}
                    onChange={(event) => setJsonText(event.target.value)}
                    placeholder={'{\n  "mcpServers": {\n    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }\n  }\n}'}
                    className="min-h-52 font-mono text-xs"
                    spellCheck={false}
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-8 gap-1.5 text-xs"
                    onClick={() => {
                      try {
                        setJsonText(JSON.stringify(JSON.parse(jsonText), null, 2));
                      } catch {
                        toast.error(t("toolbox.mcp.jsonBad"));
                      }
                    }}
                  >
                    <Braces className="size-3.5" />
                    {t("toolbox.mcp.formatJson")}
                  </Button>
                  <Button type="button" size="sm" variant="secondary" className="h-8 gap-1.5 text-xs" disabled={!jsonText.trim()} onClick={importJson}>
                    <ScanSearch className="size-3.5" />
                    {t("toolbox.mcp.jsonApply")}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-xl border border-border bg-bg-subtle/60 p-4">
                  <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{t("toolbox.mcp.sectionBasic")}</div>
                  <div className="flex flex-col gap-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label={t("toolbox.mcp.name")}>
                        <Input
                          value={draft?.name ?? ""}
                          onChange={(event) => edit({ name: event.target.value })}
                          placeholder={t("toolbox.mcp.namePlaceholder")}
                          autoFocus
                          className="font-mono"
                        />
                      </Field>
                      <Field label={t("toolbox.mcp.transport")}>
                        <select
                          value={draft?.transport ?? "stdio"}
                          onChange={(event) => edit({ transport: event.target.value })}
                          className="h-8 w-full"
                        >
                          <option value="stdio">{t("toolbox.mcp.transportStdio")}</option>
                          <option value="http">{t("toolbox.mcp.transportHttp")}</option>
                          <option value="sse">{t("toolbox.mcp.transportSse")}</option>
                        </select>
                      </Field>
                    </div>
                    <Field label={t("toolbox.prompts.description")}>
                      <Input
                        value={draft?.description ?? ""}
                        onChange={(event) => edit({ description: event.target.value })}
                        placeholder={t("toolbox.mcp.descriptionPlaceholder")}
                      />
                    </Field>
                    <Field label={t("toolbox.tags.title")}>
                      <TagInput value={draft?.tags ?? []} onChange={(tags) => edit({ tags })} />
                    </Field>
                    <label className="flex w-fit items-center gap-2 text-xs text-ink-2">
                      <input type="checkbox" checked={draft?.enabled ?? true} onChange={(event) => edit({ enabled: event.target.checked })} />
                      {t("toolbox.mcp.enabled")}
                    </label>
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-bg-subtle/60 p-4">
                  <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{t("toolbox.mcp.sectionConn")}</div>
                  {draft?.transport === "stdio" ? (
                    <div className="flex flex-col gap-4">
                      <Field label={t("toolbox.mcp.command")}>
                        <Input
                          value={draft.command}
                          onChange={(event) => edit({ command: event.target.value })}
                          placeholder={t("toolbox.mcp.commandPlaceholder")}
                          className="font-mono"
                        />
                      </Field>
                      <Field label={t("toolbox.mcp.args")} hint={t("toolbox.mcp.argsHint")}>
                        <Textarea
                          value={argsText}
                          onChange={(event) => setArgsText(event.target.value)}
                          placeholder={"-y\n@upstash/context7-mcp"}
                          className="min-h-20 font-mono text-xs"
                          spellCheck={false}
                        />
                      </Field>
                      <Field label={t("toolbox.mcp.env")} hint={t("toolbox.mcp.pairsHint")}>
                        <KeyValueEditor rows={envRows} onChange={setEnvRows} keyPlaceholder="API_KEY" valuePlaceholder="xxx" />
                      </Field>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-4">
                      <Field label={t("toolbox.mcp.url")}>
                        <Input
                          value={draft?.url ?? ""}
                          onChange={(event) => edit({ url: event.target.value })}
                          className="font-mono"
                          dir="ltr"
                        />
                      </Field>
                      <Field label={t("toolbox.mcp.headers")} hint={t("toolbox.mcp.pairsHint")}>
                        <KeyValueEditor rows={headerRows} onChange={setHeaderRows} keyPlaceholder="Authorization" valuePlaceholder="Bearer xxx" />
                      </Field>
                    </div>
                  )}
                </div>
              </>
            )}
          </DialogBody>

          <DialogFooter className="flex-wrap">
            <span className="text-[11px] text-ink-3 sm:mr-auto">{dirty ? t("toolbox.unsaved") : null}</span>
            <Button size="sm" variant="secondary" className="w-fit" onClick={() => { setDraft(null); setSaved(null); }}>
              {t("toolbox.cancel")}
            </Button>
            <Button size="sm" className="w-fit" disabled={busy || !draft?.name.trim() || editorTab === "json"} onClick={() => void save()}>
              {t("toolbox.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        title={t("toolbox.mcp.deleteTitle", { name: deleting?.name ?? "" })}
        body={t("toolbox.mcp.deleteBody")}
        confirmLabel={t("toolbox.delete")}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => void remove()}
      />

      <ConfirmDialog
        open={batchDeleteOpen}
        title={t("toolbox.mcp.batchDeleteTitle", { count: batchSel.size })}
        body={t("toolbox.mcp.batchDeleteBody", { count: batchSel.size })}
        confirmLabel={t("toolbox.delete")}
        danger
        onCancel={() => setBatchDeleteOpen(false)}
        onConfirm={() => void removeBatch()}
      />
    </ToolboxPage>
  );
}
