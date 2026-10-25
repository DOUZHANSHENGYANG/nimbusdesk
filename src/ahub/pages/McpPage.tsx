import { Braces, Check, ClipboardPaste, Copy, FolderOpen, ListChecks, Plus, PlugZap, ScanSearch, Server, Sparkles, Trash2, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/ahub/components/ConfirmDialog";
import { matchTags, type TagMode } from "@/ahub/components/TagFilter";
import { TagShelf } from "@/ahub/components/TagShelf";
import { TagManagerDialog } from "@/ahub/components/TagManagerDialog";
import { TagCommand } from "@/ahub/components/TagCommand";
import { SearchBar } from "@/ahub/components/SearchBar";
import { HarnessConfigDialog } from "@/ahub/components/HarnessConfigDialog";
import { KeyValueEditor, recordFromRows, rowsFromRecord, type KvRow } from "@/ahub/components/KeyValueEditor";
import { EmptyState } from "@/ahub/components/EmptyState";
import { HarnessDialog } from "@/ahub/components/HarnessDialog";
import { PageShell } from "@/ahub/components/PageShell";
import { TagInput } from "@/ahub/components/TagInput";
import { Badge } from "@/ahub/components/ui/badge";
import { Button } from "@/ahub/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ahub/components/ui/dialog";
import { Field, Input, Textarea } from "@/ahub/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ahub/components/ui/select";
import { api, copyText, pasteText } from "@/ahub/lib/api";
import { parseMcpConfig } from "@/ahub/lib/mcpParse";
import { sortByOrder } from "@/ahub/lib/harnessOrder";
import type { HarnessReport, McpServer, McpTestResult } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";
import { useData } from "@/ahub/stores/data";
import { useSettings } from "@/ahub/stores/settings";

/** 稳定的空数组引用：给 zustand selector 做兜底 */
const EMPTY_ORDER: string[] = [];

function newServer(): McpServer {
  return {
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
    targets: [],
    targetsInitialized: true,
    origin: null,
    versions: [],
    createdAt: "",
    updatedAt: "",
  };
}

export function McpPage() {
  const { t } = useTranslation();
  const mcp = useData((s) => s.mcp);
  const saveMcp = useData((s) => s.saveMcp);
  const deleteMcp = useData((s) => s.deleteMcp);
  const loadMcp = useData((s) => s.loadMcp);

  const [query, setQuery] = useState("");
  const [transportFilter, setTransportFilter] = useState("all");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [deleting, setDeleting] = useState<McpServer | null>(null);
  const [scanOpen, setScanOpen] = useState(false);

  const [importJsonText, setImportJsonText] = useState("");
  const [importJsonName, setImportJsonName] = useState("");
  const [newMode, setNewMode] = useState<"manual" | "json">("manual");
  const [batchMode, setBatchMode] = useState(false);
  const [batchSel, setBatchSel] = useState<Set<string>>(new Set());
  const [reports, setReports] = useState<HarnessReport[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [tagCommandOpen, setTagCommandOpen] = useState(false);
  const [tagMode, setTagMode] = useState<TagMode>("or");
  // 连通性测试：进行中的服务 id + 每个服务最近一次的结果
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, McpTestResult>>({});
  const [batchTesting, setBatchTesting] = useState(false);
  // AI 打标签弹框
  const [tagTarget, setTagTarget] = useState<McpServer | null>(null);
  const [suggested, setSuggested] = useState<string[]>([]);
  const [tagLoading, setTagLoading] = useState(false);
  const [newTag, setNewTag] = useState("");
  // 同 HarnessDialog：兜底数组必须是稳定引用，否则 selector 每次返回新数组
  // → zustand 的 Object.is 比较永远不等 → info 未加载时无限重渲染
  const harnessOrder = useSettings((s) => s.info?.settings.harnessOrder ?? EMPTY_ORDER);

  // editor draft
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [transport, setTransport] = useState("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envRows, setEnvRows] = useState<KvRow[]>([]);
  const [url, setUrl] = useState("");
  const [headerRows, setHeaderRows] = useState<KvRow[]>([]);
  const [tags, setTags] = useState<string[]>([]);

  /** 标签 → 当前上下文下的条目数（与 Skills 页同一套语义） */
  const tagCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of mcp) for (const tg of s.tags) m[tg] = (m[tg] ?? 0) + 1;
    return m;
  }, [mcp]);

  const allTags = useMemo(() => {
    const keys = new Set<string>(Object.keys(tagCounts));
    // 已选标签始终保留，避免筛选后无法取消
    activeTags.forEach((k) => keys.add(k));
    return [...keys].sort((a, b) => (tagCounts[b] ?? 0) - (tagCounts[a] ?? 0) || a.localeCompare(b));
  }, [tagCounts, activeTags]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = mcp.filter((s) => {
      if (transportFilter !== "all" && s.transport !== transportFilter) return false;
      if (!matchTags(s.tags, activeTags, tagMode)) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.command.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((tg) => tg.toLowerCase().includes(q))
      );
    });
    if (!harnessOrder.length) return list;
    const rank = (s: McpServer) => {
      const hid = (s.targets ?? [])[0] ?? s.origin?.harness ?? "";
      const i = harnessOrder.indexOf(hid);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return list.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i).map(({ x }) => x);
  }, [mcp, query, transportFilter, harnessOrder, activeTags, tagMode]);

  const openNew = () => {
    setNewMode("manual");
    setImportJsonText("");
    setImportJsonName("");
    const s = newServer();
    setEditing(s);
    setName("");
    setDescription("");
    setTransport("stdio");
    setCommand("");
    setArgsText("");
    setEnvRows([]);
    setUrl("");
    setHeaderRows([]);
    setTags([]);
    setEditorOpen(true);
  };

  const openEdit = (s: McpServer) => {
    setEditing(s);
    setName(s.name);
    setDescription(s.description);
    setTransport(s.transport);
    setCommand(s.command);
    setArgsText(s.args.join("\n"));
    setEnvRows(rowsFromRecord(s.env));
    setUrl(s.url);
    setHeaderRows(rowsFromRecord(s.headers));
    setTags(s.tags);
    // 编辑态也预填 JSON：切过去就能直接改，而不是面对一个空框
    setNewMode("manual");
    setImportJsonText(JSON.stringify(entryFor(s), null, 2));
    setEditorOpen(true);
  };

  /** 单个服务的 MCP 条目形态（不含外层 mcpServers 包裹，便于直接编辑） */
  function entryFor(s: McpServer): Record<string, unknown> {
    const base: Record<string, unknown> =
      s.transport === "stdio"
        ? {
            command: s.command,
            ...(s.args.length ? { args: s.args } : {}),
            ...(Object.keys(s.env).length ? { env: s.env } : {}),
          }
        : {
            type: s.transport,
            url: s.url,
            ...(Object.keys(s.headers).length ? { headers: s.headers } : {}),
          };
    return base;
  }

  /** 从剪贴板读 JSON 填入编辑器 */
  const pasteFromClipboard = async () => {
    const text = await pasteText();
    if (text === null) {
      toast.error(t("mcp.pasteFailed"));
      return;
    }
    if (!text.trim()) {
      toast.warning(t("mcp.pasteEmpty"));
      return;
    }
    setImportJsonText(text.trim());
    toast.success(t("mcp.pasted"));
  };

  /** 格式化当前 JSON（解析失败只提示，不改内容） */
  const formatJson = async () => {
    try {
      const parsed = JSON.parse(importJsonText) as unknown;
      setImportJsonText(JSON.stringify(parsed, null, 2));
    } catch {
      toast.error(t("mcp.jsonBad"));
    }
  };

  const handleSave = async () => {
    if (!editing) return;

    // 两种编辑方式各自生效，互不覆盖：
    //   表单模式 → 用表单状态（transport/command/args/env/url/headers）
    //   JSON 模式 → 以 JSON 为准（用户在这里改的内容必须真正写进去）
    let fields: Partial<McpServer>;
    if (newMode === "json") {
      try {
        fields = parseEntryJson(importJsonText);
      } catch (e) {
        toast.error(`${t("mcp.jsonBad")}: ${String(e)}`);
        return;
      }
    } else {
      fields = {
        transport,
        command: transport === "stdio" ? command.trim() : "",
        args: transport === "stdio" ? argsText.split(String.fromCharCode(10)).map((x) => x.trim()).filter(Boolean) : [],
        env: transport === "stdio" ? recordFromRows(envRows) : {},
        url: transport !== "stdio" ? url.trim() : "",
        headers: transport !== "stdio" ? recordFromRows(headerRows) : {},
      };
    }

    const finalName = fields.name?.trim() || name.trim();
    if (!finalName) {
      toast.error(t("mcp.nameRequired"));
      return;
    }

    await saveMcp({
      ...editing,
      ...fields,
      name: finalName,
      description: description.trim(),
      tags,
    });
    toast.success(t("mcp.saved"));
    setEditorOpen(false);
  };

  /**
   * 解析单个服务的 JSON。复用统一的 parseMcpConfig：
   * 外层包裹（mcpServers / servers / mcp）与无包裹形态都由它处理，
   * 这里只取第一个条目 —— 本弹框用于「编辑单个服务」。
   */
  function parseEntryJson(text: string): Partial<McpServer> {
    const r = parseMcpConfig(text, name.trim() || "edited");
    if (!r.entries.length) {
      throw new Error(t("mcp.jsonNoEntry"));
    }
    const e = r.entries[0];
    return {
      name: e.name,
      transport: e.transport,
      command: e.command,
      args: e.args,
      env: e.env,
      url: e.url,
      headers: e.headers,
    };
  }



  const doScan = () => {
    setScanning(true);
    api
      .scanHarnesses()
      .then(setReports)
      .catch(() => setReports([]))
      .finally(() => setScanning(false));
  };

  /** 连通性测试：stdio 跑 --help / http·sse GET，结果显示在卡片上 */
  const runTest = (s: McpServer) => {
    setTesting(s.id);
    api
      .testMcpConnectivity(s)
      .then((r) => setTestResults((prev) => ({ ...prev, [s.id]: r })))
      .catch((e) => toast.error(`${t("mcp.testConnectivity")}: ${String(e)}`))
      .finally(() => setTesting(null));
  };

  /** 批量测试：并发测全部服务，结果写入同一个 testResults，由各卡片自行展示 */
  const runBatchTest = async () => {
    setBatchTesting(true);
    const settled = await Promise.allSettled(mcp.map((m) => api.testMcpConnectivity(m)));
    setTestResults((prev) => {
      const next = { ...prev };
      mcp.forEach((m, i) => {
        const r = settled[i];
        // 失败的也落一条 ❌，卡片上能看到原因，而不是静默没有结果
        next[m.id] =
          r.status === "fulfilled"
            ? r.value
            : { ok: false, message: String(r.reason), elapsedMs: 0, timedOut: false };
      });
      return next;
    });
    setBatchTesting(false);
  };

  /** AI 打标签：拿建议 → 弹框人工增删 → 确认才写入 */
  const openAiTags = (s: McpServer) => {
    setTagTarget(s);
    setSuggested([]);
    setNewTag("");
    setTagLoading(true);
    api
      .aiSuggestTags(s.name, s.description)
      .then(setSuggested)
      .catch((e) => {
        toast.error(String(e));
        setTagTarget(null);
      })
      .finally(() => setTagLoading(false));
  };

  const confirmAiTags = async () => {
    if (!tagTarget) return;
    // 与现有标签合并去重：弹框只决定「新增哪些」，不覆盖已有标签
    await saveMcp({ ...tagTarget, tags: [...new Set([...tagTarget.tags, ...suggested])] });
    toast.success(t("mcp.saved"));
    setTagTarget(null);
  };

  const addTagManually = () => {
    const v = newTag.trim();
    if (v && !suggested.includes(v)) setSuggested((p) => [...p, v]);
    setNewTag("");
  };

  const ensureScan = () => {
    if (reports) return;
    doScan();
  };

  /** 按用户自定义顺序排列 harness 列表 */
  const ordered = (list: HarnessReport[] | null) => sortByOrder(list, harnessOrder);

  useEffect(() => {
    if (editorOpen) ensureScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorOpen]);

  const harnessName = (hid: string) => reports?.find((r) => r.id === hid)?.name ?? hid;

  const openMcpFile = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const file = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (typeof file !== "string") return;
      const r = await api.readImportFile(file);
      setImportJsonText(r.text);
      if (!importJsonName.trim()) setImportJsonName(r.name.replace(/\.json$/i, ""));
      toast.success(t("mcp.fileLoaded", { name: r.name }));
    } catch (e) {
      toast.error(`${t("mcp.fileReadFail")}: ${String(e)}`);
    }
  };

  const handleImportJson = async () => {
    let parsed;
    try {
      parsed = parseMcpConfig(importJsonText, importJsonName.trim() || "imported-mcp");
    } catch (e) {
      toast.error(`${t("mcp.importJsonBad")}: ${String(e)}`);
      return;
    }
    if (!parsed.entries.length) {
      toast.error(t("mcp.importJsonBad"));
      return;
    }
    // 解析出但被跳过的条目要告知用户，不能静默丢弃
    if (parsed.skipped.length) {
      toast.warning(t("mcp.importSkipped", { n: parsed.skipped.length, names: parsed.skipped.join(", ") }));
    }
    let ok = 0;
    for (const e of parsed.entries) {
      const s = newServer();
      s.name = e.name;
      s.enabled = true;
      s.transport = e.transport;
      s.command = e.command;
      s.args = e.args;
      s.env = e.env;
      s.url = e.url;
      s.headers = e.headers;
      await saveMcp(s);
      ok += 1;
    }
    toast.success(t("mcp.importJsonDone", { count: ok }));
    setImportJsonText("");
    setImportJsonName("");
  };

  const singleJson = (s: McpServer) => JSON.stringify(exportServers([s]), null, 2);

  function exportServers(list: McpServer[]) {
    const map: Record<string, unknown> = {};
    list.forEach((s) => {
      map[s.name] =
        s.transport === "stdio"
          ? { command: s.command, args: s.args, env: s.env }
          : { type: s.transport, url: s.url, headers: s.headers };
    });
    return { mcpServers: map };
  }

  /** 治理台里改名/删标签：逐个写回 MCP 条目 */
  const rewriteMcpTags = async (map: (tags: string[]) => string[]) => {
    for (const server of mcp) {
      const current = server.tags ?? [];
      const next = map(current);
      if (next.join("\u0001") === current.join("\u0001")) continue;
      await saveMcp({ ...server, tags: next });
    }
  };

  return (
    <PageShell
      title={t("nav.mcp")}
      actions={
        <>
          <SearchBar value={query} onChange={setQuery} placeholder={t("mcp.searchPlaceholder")} className="w-56" />
          <Select value={transportFilter} onValueChange={setTransportFilter}>
            <SelectTrigger className="h-9 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("common.all")}</SelectItem>
              <SelectItem value="stdio">stdio</SelectItem>
              <SelectItem value="http">http</SelectItem>
              <SelectItem value="sse">sse</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="secondary"
            onClick={() => {
              ensureScan();
              setCfgOpen(true);
            }}
          >
            <Wrench />
            {t("mcp.harnessCfg")}
          </Button>
          <Button variant="secondary" onClick={() => setScanOpen(true)}>
            <ScanSearch />
            {t("common.scan")}
          </Button>
          <Button onClick={openNew}>
            <Plus />
            {t("mcp.newServer")}
          </Button>
        </>
      }
    >
      {/* 标签筛选常驻：即便当前没有标签也保留入口，否则用户不知道有这个能力，
          与 Skills 页保持一致（那边是无条件显示的） */}
      <TagShelf
        allTags={allTags}
        selected={activeTags}
        onChange={setActiveTags}
        mode={tagMode}
        onModeChange={setTagMode}
        counts={tagCounts}
        hideWhenEmpty={false}
        onManage={() => setTagManagerOpen(true)}
        onCommand={() => setTagCommandOpen(true)}
      />

      {filtered.length > 0 ? (
        <div data-anim className="mb-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={batchMode ? "default" : "secondary"}
            className="h-8"
            onClick={() => {
              setBatchMode((v) => !v);
              setBatchSel(new Set());
            }}
          >
            <ListChecks />
            {batchMode ? t("mcp.batchExit") : t("mcp.batchEnter")}
          </Button>
          {/* 批量测试是全局动作，放工具栏只出现一次；每张卡片的「测试连通性」仍测单个 */}
          <Button
            size="sm"
            variant="secondary"
            className="h-8"
            disabled={batchTesting || filtered.length === 0}
            onClick={() => void runBatchTest()}
          >
            <PlugZap />
            {t("mcp.batchTest")}
          </Button>
          {batchMode ? (
            <>
              <span className="text-[11px] text-ink-3">{t("mcp.batchHint")}</span>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-8"
                  disabled={batchSel.size === 0}
                  onClick={() => {
                    const list = filtered.filter((x) => batchSel.has(x.id));
                    void copyText(JSON.stringify(exportServers(list), null, 2)).then((ok) =>
                      ok ? toast.success(t("mcp.batchCopied", { n: batchSel.size })) : toast.error(t("common.copy")),
                    );
                  }}
                >
                  <Copy />
                  {t("mcp.batchCopyJson")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-8"
                  onClick={() =>
                    setBatchSel((prev) =>
                      filtered.length > 0 && prev.size === filtered.length
                        ? new Set()
                        : new Set(filtered.map((x) => x.id)),
                    )
                  }
                >
                  {filtered.length > 0 && batchSel.size === filtered.length ? t("mcp.unselectAll") : t("harness.selectAll")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-8 text-danger hover:bg-danger/10 hover:text-danger"
                  onClick={() => setBatchDeleteOpen(true)}
                  disabled={batchSel.size === 0}
                >
                  <Trash2 className="size-3.5" />
                  {t("mcp.batchDelete")}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <EmptyState
          icon={Server}
          title={t("common.empty")}
          hint={t("mcp.emptyHint")}
          action={
            <Button onClick={() => setScanOpen(true)} variant="secondary">
              <ScanSearch />
              {t("common.scan")}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((s) => (
            <div
              key={s.id}
              data-anim
              onClick={() => {
                if (!batchMode) return;
                setBatchSel((prev) => {
                  const next = new Set(prev);
                  if (next.has(s.id)) next.delete(s.id);
                  else next.add(s.id);
                  return next;
                });
              }}
              onDoubleClick={() => openEdit(s)}
              className={cn(
                "group flex flex-col rounded-xl border border-border bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md",
                !s.enabled && "opacity-60",
                batchMode && "cursor-pointer",
                batchMode && batchSel.has(s.id) && "border-primary shadow-[0_0_0_3px_var(--ah-primary-soft)]",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-foreground">{s.name}</h3>
                {batchMode ? (
                  <span
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded border",
                      batchSel.has(s.id) ? "border-primary bg-primary text-white" : "border-border-strong",
                    )}
                  >
                    {batchSel.has(s.id) ? <Check className="size-3.5" strokeWidth={3} /> : null}
                  </span>
                ) : (s.targets ?? []).length ? (
                  <span className="shrink-0 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary">
                    {t("mcp.applyCount", { n: (s.targets ?? []).length })}
                  </span>
                ) : (
                  <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-3">
                    {t("mcp.poolOnly")}
                  </span>
                )}
              </div>
              {s.description ? <p className="mt-1 line-clamp-1 text-xs text-ink-2">{s.description}</p> : null}
              <div className="mt-2 truncate rounded-md bg-bg-subtle px-2 py-1.5 font-mono text-[11px] text-ink-2" dir="ltr">
                {s.transport === "stdio" ? `${s.command} ${s.args.join(" ")}`.trim() : s.url || "—"}
              </div>
              {testResults[s.id] ? (
                (() => {
                  const r = testResults[s.id];
                  return (
                    <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
                      <span className={cn("shrink-0 font-medium", r.ok ? "text-success" : "text-danger")}>
                        {r.timedOut ? t("mcp.testResult_timeout") : r.ok ? t("mcp.testResult_ok") : t("mcp.testResult_fail")}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ink-3" title={r.message}>
                        {r.message}
                      </span>
                      <span className="shrink-0 tabular-nums text-ink-3">{r.elapsedMs}ms</span>
                    </div>
                  );
                })()
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-1">
                <Badge variant={s.transport === "stdio" ? "info" : "warning"}>{s.transport}</Badge>
                {s.tags.map((tg) => (
                  <Badge key={tg} variant="default">
                    {tg}
                  </Badge>
                ))}
                {s.origin ? (
                  <Badge variant="muted" title={s.origin.file}>
                    {t("mcp.origin")}: {s.origin.harness}
                  </Badge>
                ) : null}
                {(s.targets ?? []).map((hid) => (
                  <Badge key={hid} variant="info">
                    {harnessName(hid)}
                  </Badge>
                ))}
              </div>
              <div className="mt-auto flex flex-wrap items-center justify-end gap-0.5 pt-3">
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 px-2.5 text-[11px]"
                  disabled={testing === s.id || batchTesting}
                  onClick={() => runTest(s)}
                >
                  <PlugZap className="size-3.5" />
                  {t("mcp.testConnectivity")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 px-2.5 text-[11px]"
                  onClick={() => openAiTags(s)}
                >
                  <Sparkles className="size-3.5" />
                  {t("mcp.aiTags")}
                </Button>
                <Button
                  size="iconSm"
                  variant="ghost"
                  title={t("mcp.copyJson")}
                  onClick={() => void copyText(singleJson(s)).then((ok) => ok && toast.success(t("common.copied")))}
                >
                  <Copy />
                </Button>
                <Button size="sm" variant="secondary" className="h-7 px-2.5 text-[11px]" onClick={() => openEdit(s)}>
                  {t("common.edit")}
                </Button>
                <Button size="iconSm" variant="ghost" title={t("common.delete")} onClick={() => setDeleting(s)}>
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* editor / new（统一入口：Tab 切换 手动填写 / 导入 JSON） */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent wide>
          <DialogHeader>
            <DialogTitle>{editing?.id ? t("mcp.editTitle") : t("mcp.newTitle")}</DialogTitle>
            {/* 表单 / JSON 两种编辑方式始终可用 —— 编辑已有服务时也应能直接改 JSON */}
            <div className="mt-2 flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5 w-fit">
              <button
                type="button"
                onClick={() => setNewMode("manual")}
                  className={cn(
                    "rounded-md px-3 py-1 text-[11px] font-medium outline-none transition-colors",
                    newMode === "manual" ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
                  )}
                >
                  {t("mcp.tabManual")}
                </button>
                <button
                  type="button"
                  onClick={() => setNewMode("json")}
                  className={cn(
                    "rounded-md px-3 py-1 text-[11px] font-medium outline-none transition-colors",
                    newMode === "json" ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
                  )}
                >
                  {t("mcp.tabJson")}
                </button>
              </div>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSave();
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <DialogBody className="flex flex-col gap-4">
              {newMode === "json" ? (
                <>
                  <p className="rounded-lg bg-bg-subtle px-3 py-2.5 text-xs leading-relaxed text-ink-2">
                    {editing?.id ? t("mcp.jsonExplainEdit") : t("mcp.jsonExplain")}
                  </p>
                  {!editing?.id ? (
                    <Field label={t("mcp.importJsonName")}>
                      <Input value={importJsonName} onChange={(e) => setImportJsonName(e.target.value)} className="font-mono" />
                    </Field>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" className="h-8 gap-1.5 text-xs" onClick={() => void openMcpFile()}>
                      <FolderOpen className="size-3.5" />
                      {t("mcp.openFile")}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-8 gap-1.5 text-xs"
                      onClick={() => void pasteFromClipboard()}
                    >
                      <ClipboardPaste className="size-3.5" />
                      {t("mcp.pasteClipboard")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-8 gap-1.5 text-xs"
                      onClick={() => void formatJson()}
                    >
                      <Braces className="size-3.5" />
                      {t("mcp.formatJson")}
                    </Button>
                  </div>
                  <Field label="JSON" className="flex min-h-0 flex-1 flex-col">
                    <Textarea
                      value={importJsonText}
                      onChange={(e) => setImportJsonText(e.target.value)}
                      placeholder={'{\n  "mcpServers": {\n    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }\n  }\n}'}
                      className="min-h-52 flex-1 font-mono text-xs"
                    />
                  </Field>
                </>
              ) : (
              <>
              {/* 基本信息 */}
              <div className="rounded-xl border border-border bg-bg-subtle/60 p-4">
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                  {t("mcp.sectionBasic")}
                </div>
                <div className="flex flex-col gap-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("common.name")}>
                      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("mcp.namePlaceholder")} autoFocus className="font-mono" />
                    </Field>
                    <Field label={t("mcp.transport")}>
                      <Select value={transport} onValueChange={setTransport}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="stdio">{t("mcp.transportStdio")}</SelectItem>
                          <SelectItem value="http">{t("mcp.transportHttp")}</SelectItem>
                          <SelectItem value="sse">{t("mcp.transportSse")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <Field label={t("common.description")}>
                    <Input value={description} onChange={(e) => setDescription(e.target.value)} />
                  </Field>
                  <Field label={t("common.tags")}>
                    <TagInput value={tags} onChange={setTags} />
                  </Field>
                </div>
              </div>

              {/* 连接配置 */}
              <div className="rounded-xl border border-border bg-bg-subtle/60 p-4">
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                  {t("mcp.sectionConn")}
                </div>
                {transport === "stdio" ? (
                  <div className="flex flex-col gap-4">
                    <Field label={t("mcp.command")}>
                      <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder={t("mcp.commandPlaceholder")} className="font-mono" />
                    </Field>
                    <Field label={t("mcp.args")} hint={t("mcp.argsPlaceholder").replace("&#10;", "\n")}>
                      <Textarea value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder={"-y\n@upstash/context7-mcp"} className="font-mono text-xs" />
                    </Field>
                    <Field label={t("mcp.env")} hint={t("mcp.envHint")}>
                      <KeyValueEditor rows={envRows} onChange={setEnvRows} keyPlaceholder={"API_KEY"} valuePlaceholder={"xxx"} />
                    </Field>
                  </div>
                ) : (
                  <div className="flex flex-col gap-4">
                    <Field label={t("mcp.url")}>
                      <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("mcp.urlPlaceholder")} className="font-mono" />
                    </Field>
                    <Field label={t("mcp.headers")} hint={t("mcp.headersHint")}>
                      <KeyValueEditor rows={headerRows} onChange={setHeaderRows} keyPlaceholder={"Authorization"} valuePlaceholder={"Bearer xxx"} />
                    </Field>
                  </div>
                )}
              </div>

              </>
              )}
            </DialogBody>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setEditorOpen(false)}>
                {t("common.cancel")}
              </Button>
              {newMode === "json" && !editing?.id ? (
                <Button
                  type="button"
                  disabled={!importJsonText.trim()}
                  onClick={() => void handleImportJson().then(() => setEditorOpen(false))}
                >
                  {t("mcp.importJsonGo")}
                </Button>
              ) : (
                <Button type="submit" disabled={!name.trim()}>
                  {t("common.save")}
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* AI 打标签：建议标签可点击移除，输入框可手动补充，确认才写入 */}
      <Dialog open={!!tagTarget} onOpenChange={(v) => !v && setTagTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("mcp.tagDialogTitle")}</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            {tagLoading ? (
              <p className="text-xs text-ink-3">{t("mcp.tagLoading")}</p>
            ) : suggested.length ? (
              <p className="text-[11px] text-ink-3">{t("mcp.tagRemoveHint")}</p>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              {suggested.map((tg) => (
                <button
                  key={tg}
                  type="button"
                  onClick={() => setSuggested((p) => p.filter((x) => x !== tg))}
                  className="rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-foreground outline-none transition-colors hover:border-danger hover:text-danger focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {tg} ×
                </button>
              ))}
            </div>
            <Input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTagManually();
                }
              }}
              placeholder={t("mcp.tagAddPlaceholder")}
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setTagTarget(null)}>
              {t("mcp.tagCancel")}
            </Button>
            <Button disabled={tagLoading} onClick={() => void confirmAiTags()}>
              {t("mcp.tagConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={batchDeleteOpen}
        onOpenChange={setBatchDeleteOpen}
        title={t("mcp.batchDeleteTitle")}
        message={t("mcp.batchDeleteMsg", { n: batchSel.size })}
        danger
        onConfirm={() => {
          const list = filtered.filter((x) => batchSel.has(x.id));
          void (async () => {
            for (const s0 of list) await deleteMcp(s0.id);
            toast.success(t("mcp.batchDeleted", { n: list.length }));
            setBatchSel(new Set());
          })();
        }}
      />

      <HarnessConfigDialog
        open={cfgOpen}
        onOpenChange={setCfgOpen}
        reports={ordered(reports)}
        scanning={scanning}
        onRescan={doScan}
        pool={mcp}
        onChanged={() => void loadMcp()}
      />

      <HarnessDialog open={scanOpen} onOpenChange={setScanOpen} kind="mcp" />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={t("mcp.deleteConfirmTitle")}
        message={t("mcp.deleteConfirmMsg", { name: deleting?.name ?? "" })}
        danger
        onConfirm={() => {
          if (deleting) void deleteMcp(deleting.id).then(() => toast.success(t("mcp.deleted")));
        }}
      />
      <TagManagerDialog
        open={tagManagerOpen}
        onOpenChange={setTagManagerOpen}
        allTags={allTags}
        counts={tagCounts}
        onRenameTag={(from, to) => rewriteMcpTags((tags) => tags.map((tag) => (tag === from ? to : tag)))}
        onDeleteTag={(tag) => rewriteMcpTags((tags) => tags.filter((item) => item !== tag))}
      />
      <TagCommand
        open={tagCommandOpen}
        onOpenChange={setTagCommandOpen}
        allTags={allTags}
        counts={tagCounts}
        selected={activeTags}
        onToggle={(tag) => {
          const next = new Set(activeTags);
          if (next.has(tag)) next.delete(tag);
          else next.add(tag);
          setActiveTags(next);
        }}
        resultCount={filtered.length}
      />
    </PageShell>
  );
}
