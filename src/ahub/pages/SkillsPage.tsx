import { Archive, ArrowRight, Boxes, Check, ChevronDown, ChevronRight, CircleAlert, CircleSlash, Clock, CloudUpload, Columns2, Eye, FolderOpen, GitCompare, History, LayoutGrid, Layers, ListChecks, Loader2, Package, Paperclip, Pencil, Play, Plus, RefreshCw, RotateCw, Save, ScanSearch, Settings2, ShieldAlert, ShieldCheck, Sparkles, Tag, Trash2, X, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/ahub/components/ConfirmDialog";
import { EmptyState } from "@/ahub/components/EmptyState";
import { matchTags, type TagMode } from "@/ahub/components/TagFilter";
import { TagShelf } from "@/ahub/components/TagShelf";
import { BatchTagDialog, TagPicker } from "@/ahub/components/TagPicker";
import { UpstreamCheckDialog, UpstreamCheckIcon, type UpstreamRow } from "@/ahub/components/UpstreamCheckDialog";
import { SkillPipelineDialog, type PipelineStepId } from "@/ahub/components/SkillPipelineDialog";
import { TagManagerView } from "@/ahub/components/TagManagerView";
import { TagCommand } from "@/ahub/components/TagCommand";
import { SearchBar } from "@/ahub/components/SearchBar";
import { HarnessDialog } from "@/ahub/components/HarnessDialog";
import { HarnessIcon } from "@/ahub/components/HarnessIcon";
import { HarnessFilterRail } from "@/ahub/components/HarnessFilterRail";
import { HarnessBatchDialog } from "@/ahub/components/HarnessBatchDialog";
import { Markdown } from "@/ahub/components/Markdown";
import { PageShell } from "@/ahub/components/PageShell";
import { SkillPicker } from "@/ahub/components/SkillPicker";
import { VersionList } from "@/ahub/components/VersionList";
import { VetReviewPanel } from "@/ahub/components/VetReviewPanel";
import { SkillFileBrowser } from "@/ahub/components/SkillFileBrowser";
import { SkillSummaryPanel } from "@/ahub/components/SkillSummary";
import { CollapsibleCard } from "@/ahub/components/CollapsibleCard";
import { Badge } from "@/ahub/components/ui/badge";
import { Button } from "@/ahub/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ahub/components/ui/dialog";
import { Field, Input, Textarea } from "@/ahub/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ahub/components/ui/select";
import { Switch } from "@/ahub/components/motion/switch";
import { api } from "@/ahub/lib/api";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AddSkillDialog } from "@/ahub/components/AddSkillDialog";
import { PresetBar } from "@/ahub/components/PresetBar";
import { PresetDialog } from "@/ahub/components/PresetDialog";
import { PresetManager } from "@/ahub/components/PresetManager";
import { presetErrorText } from "@/ahub/lib/presetErrors";
import type { HarnessReport, Preset, SkillDoc, SkillMeta } from "@/ahub/lib/types";
import { appliedHarnesses, lastAppliedAt, shortHarnessName } from "@/ahub/lib/skillHarness";
import { cn } from "@/ahub/lib/utils";
import { useData } from "@/ahub/stores/data";
import { useSettings } from "@/ahub/stores/settings";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ahub/components/motion/tabs";

// SSEP 规则 → 人话（i18n key 后缀）
const VET_RULE_KEY: Record<string, string> = {
  "R01-destructive": "vetRuleR01",
  "R02-exec-download": "vetRuleR02",
  "R03-dynamic-exec": "vetRuleR03",
  "R04-system-write": "vetRuleR04",
  "R05-secrets": "vetRuleR05",
  "R06-obfuscation": "vetRuleR06",
  "R07-env-harvest": "vetRuleR07",
  "R08-cred-files": "vetRuleR08",
  "SSEP-STALE": "vetRuleStale",
};

const LIFECYCLE_ZH_KEY: Record<string, string> = {
  create: "logCreate",
  update: "logUpdate",
  vet: "logVet",
  install: "logInstall",
  pack: "logPack",
  deploy: "logDeploy",
  deprecate: "logDeprecate",
  archive: "logArchive",
  // 状态变更事件（后端 set_status 写入的是状态名本身）
  draft: "stateDraft",
  active: "stateActive",
  deprecated: "stateDeprecated",
  archived: "stateArchived",
};

/**
 * 从版本的完整 SKILL.md 里剥出正文。
 * 版本快照存的是含 frontmatter 的整份文档，而编辑器草稿只有正文，
 * 直接比较会永远判为「有改动」——发布按钮就永远可点。
 */
function bodyOfDoc(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n\n?/, "");
}

/** 格式化 ISO 时间为本地可读（失败则原样返回） */
/**
 * 时间显示。空值表示「时间不可知」——后端会剔除 DOS 纪元哨兵值
 * （ZIP 无日期时的时间戳、1980-01-01），此时显示破折号而不是假日期。
 */
function fmtTime(iso?: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function semverSatisfies(have: string, req: string): boolean {
  const req2 = req.trim();
  if (!req2) return true;
  let op = "=";
  let rest = req2;
  if (req2.startsWith(">=")) { op = ">="; rest = req2.slice(2); }
  else if (req2.startsWith(">")) { op = ">"; rest = req2.slice(1); }
  else if (req2.startsWith("==")) { op = "="; rest = req2.slice(2); }
  else if (req2.startsWith("=")) { op = "="; rest = req2.slice(1); }
  const parse = (v: string) => {
    const arr = v.split(".").map((x) => parseInt(x, 10) || 0);
    while (arr.length < 3) arr.push(0);
    return arr;
  };
  const h = parse(have);
  const r = parse(rest);
  if (op === ">=") return h[0] > r[0] || (h[0] === r[0] && (h[1] > r[1] || (h[1] === r[1] && h[2] >= r[2])));
  if (op === ">") return h[0] > r[0] || (h[0] === r[0] && (h[1] > r[1] || (h[1] === r[1] && h[2] > r[2])));
  return h[0] === r[0] && h[1] === r[1] && h[2] === r[2];
}


/** 来源工具 id → 展示名（未命中的 id 原样显示） */
const HARNESS_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  cursor: "Cursor",
  cline: "Cline",
  windsurf: "Windsurf",
  opencode: "OpenCode",
  deepseek: "DeepSeek",
  vscode: "VS Code",
  workbuddy: "WorkBuddy",
  codebuddy: "CodeBuddy",
  "pi-agent": "PI Agent",
};

/**
 * 摘要相关错误 → 界面文案：未配置 AI 时后端返回中文提示，
 * 英文界面下要换成英文（其它错误原样显示原因）。
 */
function summaryErrorText(raw: string, t: (k: string) => string): string {
  return raw.includes("尚未配置 AI API") ? t("skillSummary.needAiConfig") : raw;
}

export function SkillsPage() {
  const { t } = useTranslation();
  const skills = useData((s) => s.skills);
  const deleteSkill = useData((s) => s.deleteSkill);
  const saveSkill = useData((s) => s.saveSkill);
  const loadSkills = useData((s) => s.loadSkills);
  const dataDirs = useSettings((s) => s.info?.dataDirs);

  const [query, setQuery] = useState("");
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [tagMode, setTagMode] = useState<TagMode>("or");
  const [pageTab, setPageTab] = useState<"skills" | "tags">("skills");
  const [tagCommandOpen, setTagCommandOpen] = useState(false);
  const [batchTagOpen, setBatchTagOpen] = useState(false);
  /** 刚导入的目录名：批量打标签优先作用在这批上，而不是当前勾选 */
  const [tagTargetDirs, setTagTargetDirs] = useState<string[] | null>(null);
  const [upstreamOpen, setUpstreamOpen] = useState(false);
  const [upstreamRows, setUpstreamRows] = useState<UpstreamRow[]>([]);
  const [upstreamBusy, setUpstreamBusy] = useState(false);
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [pipelineOutDir, setPipelineOutDir] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const [harnessReports, setHarnessReports] = useState<HarnessReport[] | null>(null);
  const [harnessFilter, setHarnessFilter] = useState<string | null>(null);
  const [harnessBatchOpen, setHarnessBatchOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<"create" | "file" | "git">("file");
  const [batchMode, setBatchMode] = useState(false);
  const [batchSel, setBatchSel] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"grid" | "tag" | "tool">("grid");
  const [collapsedTools, setCollapsedTools] = useState<Set<string>>(new Set());
  const [collapsedTags, setCollapsedTags] = useState<Set<string>>(new Set());
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [onboardBusy, setOnboardBusy] = useState(false);
  const [packExport, setPackExport] = useState(false);
  const [packReport, setPackReport] = useState<{
    outDir: string;
    total: number;
    succeeded: number;
    failed: number;
    warned: number;
    indexPath: string;
    outcomes: { dirName: string; name: string; version: string; ok: boolean; path: string; warnings: string[]; error: string }[];
  } | null>(null);
  const [deleting, setDeleting] = useState<SkillMeta | null>(null);
  const [proto, setProto] = useState<Awaited<ReturnType<typeof api.skillExtension>> | null>(null);
  const [protoLoading, setProtoLoading] = useState(false);
  const [editLevel, setEditLevel] = useState("L1");
  const [extSaving, setExtSaving] = useState(false);
  const [extDeps, setExtDeps] = useState<{ name: string; semver: string; reason: string }[]>([]);
  const [extRuntime, setExtRuntime] = useState({ requires_scripts: "none", requires_network: "none", min_protocol: 1, config: "" });
  const [extUpstream, setExtUpstream] = useState({ watch: false, mode: "manual", remote: "" });
  // 批量导入向导（skills-import）
  // AI 摘要（skills-summary）：单技能生成中 / 批量生成中
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [batchSummaryBusy, setBatchSummaryBusy] = useState(false);
  // 预设（skill-presets）
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [presetManagerOpen, setPresetManagerOpen] = useState(false);
  const [presetSaveOpen, setPresetSaveOpen] = useState(false);

  /** 预设列表：后端文件损坏时把带路径的错误翻成人话提示，页面其余部分照常可用 */
  const loadPresets = async () => {
    try {
      const list = await api.presetList();
      setPresets(list);
      // 被筛选的预设已被删除 → 立刻清掉筛选，避免清单卡在空结果
      setSelectedPresetId((cur) => (cur && list.some((p) => p.id === cur) ? cur : null));
    } catch (e) {
      toast.error(presetErrorText(e, t));
    }
  };

  useEffect(() => {
    void loadPresets();
    // 只在挂载时拉一次；后续增删改各自刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadProto = async (dirName: string) => {
    setProtoLoading(true);
    try {
      setProto(await api.skillExtension(dirName));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setProtoLoading(false);
    }
  };

  useEffect(() => {
    const doc = (proto?.doc ?? null) as
      | {
          deps?: { item?: { name?: string; semver?: string; reason?: string }[] };
          runtime?: { requires_scripts?: string; requires_network?: string; min_protocol?: number; config?: string };
          source?: { upstream?: { watch?: boolean; mode?: string; remote?: string } };
        }
      | null;
    if (doc) {
      setExtDeps(
        (doc.deps?.item ?? []).map((d) => ({
          name: d.name ?? "",
          semver: d.semver ?? ">=1.0",
          reason: d.reason ?? "",
        })),
      );
      setExtRuntime({
        requires_scripts: doc.runtime?.requires_scripts ?? "none",
        requires_network: doc.runtime?.requires_network ?? "none",
        min_protocol: doc.runtime?.min_protocol ?? 1,
        config: doc.runtime?.config ?? "",
      });
      setExtUpstream({
        watch: !!doc.source?.upstream?.watch,
        mode: doc.source?.upstream?.mode ?? "manual",
        remote: doc.source?.upstream?.remote ?? "",
      });
    }
  }, [proto]);

  const saveExt = async () => {
    if (!detail) return;
    setExtSaving(true);
    try {
      await api.updateSkillExt(detail.meta.dirName, {
        deps: extDeps.filter((d) => d.name.trim()),
        runtime: {
          requiresScripts: extRuntime.requires_scripts,
          requiresNetwork: extRuntime.requires_network,
          minProtocol: extRuntime.min_protocol,
          config: extRuntime.config,
        },
        upstream: extUpstream,
      });
      toast.success(t("skills.saved"));
      await loadProto(detail.meta.dirName);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setExtSaving(false);
    }
  };

  const handleTab = (v: string) => {
    setTab(v);
    if (v === "proto" && detail) void loadProto(detail.meta.dirName);
  };


  /** 为已导入但未接入 SKILL.toml 的技能生成协议档案（CORE + 变更事件） */
  const generateProto = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await api.ensureSkillProtocol(detail.meta.dirName);
      toast.success(t("skills.protoGenerated"));
      await loadProto(detail.meta.dirName);
      await loadSkills();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 批量启用/停用。
   *
   * 逐个调 setSkillStatus 而不是新开一条批量命令：状态改动要写回每个技能
   * 自己的元信息，失败也应该只影响那一个 —— 批量命令反而要复制这份逐条
   * 错误处理，还多一处能出错的地方。
   */
  const [batchStatusBusy, setBatchStatusBusy] = useState(false);
  const setBatchStatus = async (status: "enabled" | "disabled") => {
    const targets = [...batchSel];
    if (!targets.length) return;
    setBatchStatusBusy(true);
    let ok = 0;
    let failed = 0;
    for (const dirName of targets) {
      try {
        await api.setSkillStatus(dirName, status, "");
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    await loadSkills();
    setBatchStatusBusy(false);
    if (failed) toast.warning(t("skills.batchStatusDone", { ok, failed }));
    else toast.success(t("skills.batchStatusDone", { ok, failed: 0 }));
  };

  const applyStatus = async (status: string) => {
    if (!detail) return;
    try {
      await api.setSkillStatus(detail.meta.dirName, status, "");
      toast.success(t("skills.protoStatusDone", { status }));
      await loadSkills();
      void loadProto(detail.meta.dirName);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handlePack = async () => {
    if (!detail) return;
    const picked = await openDialog({ directory: true, multiple: false, title: t("skills.protoPack") });
    if (typeof picked !== "string" || !picked) return;
    try {
      const p = await api.packSkill(detail.meta.dirName, picked);
      toast.success(t("skills.protoPacked", { path: p }));
      void loadProto(detail.meta.dirName);
    } catch (e) {
      toast.error(String(e));
    }
  };

  // detail dialog
  const [detail, setDetail] = useState<SkillDoc | null>(null);  const [detailLoading, setDetailLoading] = useState(false);
  const [tab, setTab] = useState("content");
  const [contentMode, setContentMode] = useState<"preview" | "edit" | "split">("preview");
  const [clearVerOpen, setClearVerOpen] = useState(false);
  /** 发布备注（工具栏内联输入，不再是独立卡片） */
  const [releaseNote, setReleaseNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editTags, setEditTags] = useState<string[]>([]);
  const [editBody, setEditBody] = useState("");

  /**
   * 标签池：关键词命中的技能（不含标签筛选本身），
   * 这样勾选标签时其余标签不会消失。
   */
  const tagPool = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.tags.some((tg) => tg.toLowerCase().includes(q))
      );
    });
  }, [skills, query]);

  /** 标签 → 当前上下文下的技能数 */
  const tagCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of tagPool) for (const tg of s.tags) m[tg] = (m[tg] ?? 0) + 1;
    return m;
  }, [tagPool]);

  /** 侧栏标签顺序：数量多的靠前（已选标签始终保留，避免无法取消） */
  const allTags = useMemo(() => {
    const keys = new Set<string>(Object.keys(tagCounts));
    activeTags.forEach((k) => keys.add(k));
    return [...keys].sort((a, b) => (tagCounts[b] ?? 0) - (tagCounts[a] ?? 0) || a.localeCompare(b));
  }, [tagCounts, activeTags]);

  /** 当前筛选中的预设（用于筛选条件与成员计数） */
  const selectedPreset = useMemo(
    () => presets.find((p) => p.id === selectedPresetId) ?? null,
    [presets, selectedPresetId],
  );

  /** 技能池里仍存在的目录名（预设栏与成员面板据此标出失效成员） */
  const liveDirs = useMemo(() => new Set(skills.map((s) => s.dirName)), [skills]);

  /**
   * 各 harness 的技能目录扫描结果。
   * 失败只让「工具」区块显示为空，页面其余部分照常可用 —— 不能因为工具没装就挡住技能管理。
   */
  const loadHarnesses = async () => {
    try {
      setHarnessReports(await api.scanHarnesses());
    } catch {
      setHarnessReports([]);
    }
  };

  useEffect(() => {
    void loadHarnesses();
    // 只在挂载时扫一次；接入/移出后由对话框回调刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 支持技能目录的工具 */
  const skillHarnesses = useMemo(
    () => (harnessReports ?? []).filter((r) => r.supportsSkills),
    [harnessReports],
  );

  /** dirName → 已接入的工具列表（一次算完，卡片与筛选共用） */
  const appliedMap = useMemo(() => {
    const map = new Map<string, HarnessReport[]>();
    for (const s of skills) map.set(s.dirName, appliedHarnesses(skillHarnesses, s));
    return map;
  }, [skills, skillHarnesses]);

  const harnessCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const list of appliedMap.values()) {
      for (const r of list) counts[r.id] = (counts[r.id] ?? 0) + 1;
    }
    return counts;
  }, [appliedMap]);

  const unassignedCount = useMemo(
    () => [...appliedMap.values()].filter((list) => list.length === 0).length,
    [appliedMap],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // 预设筛选：只保留成员目录名命中的技能（与其他筛选取交集）
    const presetDirs = selectedPreset ? new Set(selectedPreset.skillDirNames) : null;
    return skills.filter((s) => {
      if (presetDirs && !presetDirs.has(s.dirName)) return false;
      if (!matchTags(s.tags, activeTags, tagMode)) return false;
      // 工具收窄：左栏「未接入工具」把从未同步到任何工具的技能挑出来
      if (harnessFilter) {
        const attached = appliedMap.get(s.dirName) ?? [];
        if (harnessFilter === "__none" ? attached.length > 0 : !attached.some((r) => r.id === harnessFilter)) return false;
      }
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.tags.some((tg) => tg.toLowerCase().includes(q));
    });
  }, [skills, query, activeTags, tagMode, selectedPreset, harnessFilter, appliedMap]);

  /** 按标签分组（未打标签归入「未分类」） */
  const grouped = useMemo(() => {
    if (viewMode !== "tag") return null;
    const map = new Map<string, SkillMeta[]>();
    for (const s of filtered) {
      const keys = s.tags.length ? s.tags : [t("skills.untagged")];
      for (const k of keys) {
        const arr = map.get(k) ?? [];
        arr.push(s);
        map.set(k, arr);
      }
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [filtered, viewMode, t]);

  /** 按工具分组：同一份技能接了多个工具就会出现在多个组里；都没接的进「未接入工具」 */
  const groupedByTool = useMemo(() => {
    if (viewMode !== "tool") return null;
    const map = new Map<string, SkillMeta[]>();
    for (const s of filtered) {
      const attached = appliedMap.get(s.dirName) ?? [];
      if (attached.length === 0) {
        const arr = map.get("__none") ?? [];
        arr.push(s);
        map.set("__none", arr);
        continue;
      }
      for (const r of attached) {
        const arr = map.get(r.id) ?? [];
        arr.push(s);
        map.set(r.id, arr);
      }
    }
    const order = skillHarnesses.map((r) => r.id);
    return [...map.entries()].sort((a, b) => {
      if (a[0] === "__none") return 1;
      if (b[0] === "__none") return -1;
      return order.indexOf(a[0]) - order.indexOf(b[0]);
    });
  }, [viewMode, filtered, appliedMap, skillHarnesses]);

  /**
   * 批量打包导出：选一个输出目录，逐个生成规范 .skillpack，
   * 并在该目录写 index.json（SSEP §7.2 的发布源格式）。
   */
  const runPack = async () => {
    const targets = [...batchSel];
    if (!targets.length) {
      toast.warning(t("harness.nothingSelected"));
      return;
    }
    const picked = await openDialog({ directory: true, multiple: false, title: t("skills.packPickOut") });
    if (typeof picked !== "string" || !picked) return;
    setPackExport(true);
    try {
      const r = await api.packSkillsBatch(targets, picked);
      setPackReport(r);
      if (r.failed === 0 && r.warned === 0) {
        toast.success(t("skills.packDone", { ok: r.succeeded, dir: r.outDir }));
      } else {
        toast.warning(t("skills.packDoneWarn", { ok: r.succeeded, failed: r.failed, warned: r.warned }));
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setPackExport(false);
    }
  };

  /**
   * 批量：生成 SKILL.toml（已接入的自动跳过）+ 安全审查。
   * 一步到位，不再让用户先「选中未接入的」再点第二个按钮。
   */
  const runOnboard = async () => {
    const targets = [...batchSel];
    if (!targets.length) {
      toast.warning(t("harness.nothingSelected"));
      return;
    }
    setOnboardBusy(true);
    try {
      const r = await api.onboardSkillsBatch(targets, true, true);
      if (r.total === 0) {
        toast.info(t("skills.onboardNone"));
      } else {
        toast.success(t("skills.onboardDone", { ok: r.succeeded, created: r.created, failed: r.failed }));
        toast.info(t("skills.onboardVerdicts", { install: r.install, review: r.review, rejected: r.rejected }));
      }
      setBatchSel(new Set());
      setBatchMode(false);
      await loadSkills();
      if (detail) {
        const meta = skills.find((s) => s.dirName === detail.meta.dirName);
        if (meta) void openDetail(meta);
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setOnboardBusy(false);
    }
  };

  /** 当前是否有任何筛选条件（用于「清空筛选」）；预设筛选也算一种条件 */
  const hasFilter = query.trim().length > 0 || activeTags.size > 0 || selectedPresetId !== null || harnessFilter !== null;

  const clearFilters = () => {
    setQuery("");
    setActiveTags(new Set());
    setSelectedPresetId(null);
    setHarnessFilter(null);
  };

  /** ⌘K / Ctrl+K：打开标签检索面板 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setTagCommandOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);


  /** 批量改标签：追加 / 移除 / 清空，作用于当前勾选的技能 */
  const applyTagsToSelection = async (mode: "add" | "remove" | "clear", tags: string[]) => {
    const dirs = tagTargetDirs ?? [...batchSel];
    for (const dirName of dirs) {
      const doc = await api.readSkill(dirName);
      const next =
        mode === "clear"
          ? []
          : mode === "add"
            ? [...new Set([...doc.meta.tags, ...tags])]
            : doc.meta.tags.filter((tag) => !tags.includes(tag));
      if (next.join("\u0001") === doc.meta.tags.join("\u0001")) continue;
      await saveSkill({
        dirName,
        name: doc.meta.name,
        description: doc.meta.description,
        tags: next,
        body: doc.body,
        frontmatter: doc.frontmatter,
        level: "L1",
        publish: false,
        note: "",
      });
    }
    await loadSkills();
    toast.success(t("tagPicker.batchDone", { n: dirs.length }));
    setTagTargetDirs(null);
  };

  /** 导入完成 → 直接拉起打标签弹窗，作用范围是刚导入的这批 */
  const openTagForImported = (items: { dirName: string; name: string }[]) => {
    if (!items.length) return;
    setTagTargetDirs(items.map((it) => it.dirName));
    setBatchTagOpen(true);
  };

  /**
   * 批量检查上游：勾了就只查勾选的，没勾就查全部。
   * 逐个跑（每个一次 git ls-remote），失败只记在那一条上，不中断整批。
   */
  const runUpstreamCheck = async () => {
    const targets = batchSel.size > 0 ? skills.filter((meta) => batchSel.has(meta.dirName)) : skills;
    if (targets.length === 0) return;
    setUpstreamBusy(true);
    const rows: UpstreamRow[] = [];
    try {
      for (const meta of targets) {
        try {
          const report = await api.checkUpstream(meta.dirName);
          const status = !report.watched
            ? "untracked"
            : report.changed
              ? "changed"
              : report.remoteHead
                ? "current"
                : "error";
          rows.push({ dirName: meta.dirName, name: meta.name, status, remote: report.remote, note: report.note });
        } catch (e) {
          rows.push({ dirName: meta.dirName, name: meta.name, status: "error", remote: "", note: String(e) });
        }
      }
      setUpstreamRows(rows);
      setUpstreamOpen(true);
    } finally {
      setUpstreamBusy(false);
    }
  };

  /** 流水线单步：审查 = 体检（vet），摘要 = AI 批量，打包 = 导出 zip + index.json */
  const runPipelineStep = async (id: PipelineStepId) => {
    const targets = [...batchSel];
    if (id === "vet") {
      const report = await api.onboardSkillsBatch(targets, false, true);
      const rejected = report.outcomes.filter((o) => !o.ok).length;
      return {
        ok: report.succeeded,
        failed: report.failed,
        note: rejected > 0 ? t("skills.pipeVetRejected", { n: rejected }) : undefined,
      };
    }
    if (id === "summary") {
      const outcomes = await api.skillGenerateSummaryBatch(targets);
      const ok = outcomes.filter((o) => o.ok).length;
      await loadSkills();
      return { ok, failed: outcomes.length - ok };
    }
    const report = await api.packSkillsBatch(targets, pipelineOutDir);
    await loadSkills();
    return { ok: report.succeeded, failed: report.failed + report.warned, note: report.outDir };
  };

  const pickPipelineOutDir = async () => {
    const picked = await openDialog({ directory: true, multiple: false, title: t("skills.packPickOut") });
    if (typeof picked === "string" && picked) setPipelineOutDir(picked);
  };

  /** 点击卡片上的标签：下钻筛选 */
  const drillTag = (tg: string) =>
    setActiveTags((prev) => {
      const n = new Set(prev);
      if (n.has(tg)) n.delete(tg);
      else n.add(tg);
      return n;
    });

  const toggleGroup = (tag: string) =>
    setCollapsedTags((prev) => {
      const n = new Set(prev);
      if (n.has(tag)) n.delete(tag);
      else n.add(tag);
      return n;
    });

  const toggleToolGroup = (id: string) =>
    setCollapsedTools((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const toggleBatch = (dirName: string) =>
    setBatchSel((prev) => {
      const n = new Set(prev);
      if (n.has(dirName)) n.delete(dirName);
      else n.add(dirName);
      return n;
    });

  const openDetail = async (meta: SkillMeta) => {
    setDetailLoading(true);
    setDetail({
      meta,
      frontmatter: {},
      body: "",
      versions: [],
    });
    setTab("content");
    setContentMode("preview");
    setProto(null);
    try {
      const doc = await api.readSkill(meta.dirName);
      setDetail(doc);
      setEditName(doc.meta.name);
      setEditDesc(doc.meta.description);
      setEditTags(doc.meta.tags);
      setEditBody(doc.body);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDetailLoading(false);
    }
  };

  /**
   * 生成单个技能的 AI 摘要：写入 .hub.json 后刷新详情里的摘要区与列表（列表卡片也带摘要）。
   * 生成中禁用按钮，避免重复触发并发请求。
   */
  const generateSummary = async (dirName: string) => {
    if (summaryBusy) return;
    setSummaryBusy(true);
    try {
      const s = await api.skillGenerateSummary(dirName);
      setDetail((d) => (d && d.meta.dirName === dirName ? { ...d, meta: { ...d.meta, summary: s } } : d));
      await loadSkills();
      toast.success(t("skillSummary.done"));
    } catch (e) {
      // 失败时保留原有摘要不变（不动 detail）
      toast.error(t("skillSummary.failed", { error: summaryErrorText(String(e), t) }));
    } finally {
      setSummaryBusy(false);
    }
  };

  /** 批量生成摘要：逐个串行（后端保证），结果汇总成功/失败数；单个失败不中断其余。 */
  const runBatchSummary = async () => {
    const targets = [...batchSel];
    if (!targets.length) {
      toast.warning(t("skills.batchSummaryNone"));
      return;
    }
    setBatchSummaryBusy(true);
    try {
      const outcomes = await api.skillGenerateSummaryBatch(targets);
      const ok = outcomes.filter((o) => o.ok).length;
      const failed = outcomes.length - ok;
      if (failed === 0) {
        toast.success(t("skills.batchSummaryDone", { ok, failed }));
      } else {
        toast.warning(t("skills.batchSummaryDone", { ok, failed }));
      }
      await loadSkills();
      // 当前详情若在本次目标里，就地更新摘要 —— 不重开详情，避免丢掉未保存的编辑
      const mine = outcomes.find((o) => o.ok && o.summary && o.dirName === detail?.meta.dirName);
      if (mine?.summary) {
        const s = mine.summary;
        setDetail((d) => (d && d.meta.dirName === mine.dirName ? { ...d, meta: { ...d.meta, summary: s } } : d));
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBatchSummaryBusy(false);
    }
  };

  /**
   * 保存技能。`publish` 决定是否同时记一条版本：
   *   · false —— 暂存：只落盘，时间轴不动
   *   · true  —— 发布：落盘 + 以落盘后的内容记一条版本（后端 push_published 去重）
   * 编辑态的 `level` 只在发布时生效，决定协议版本号怎么递增。
   */
  const handleEditSave = async (publish = false) => {
    if (!detail) return;
    setBusy(true);
    try {
      await saveSkill({
        dirName: detail.meta.dirName,
        name: editName.trim(),
        description: editDesc.trim(),
        tags: editTags,
        body: editBody,
        frontmatter: detail.frontmatter,
        level: publish ? editLevel : "L1",
        publish,
        note: publish ? releaseNote.trim() : "",
      });
      if (publish) {
        setReleaseNote("");
        toast.success(t("skills.releaseSaved"));
      } else {
        toast.success(t("skills.saved"));
      }
      const meta = skills.find((s) => s.dirName === detail.meta.dirName);
      if (meta) void openDetail(meta);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 草稿相对「磁盘上的内容」是否有改动 —— 暂存按钮的开关 */
  const skillDirty = useMemo(() => {
    if (!detail) return false;
    return (
      editName !== detail.meta.name ||
      editDesc !== detail.meta.description ||
      editBody !== detail.body ||
      editTags.join("\u0001") !== detail.meta.tags.join("\u0001")
    );
  }, [detail, editName, editDesc, editBody, editTags]);

  /**
   * 草稿相对「最后一次发布的内容」是否有改动 —— 发布按钮的开关。
   * 技能的版本快照存整份 SKILL.md（含 frontmatter），草稿只有正文，
   * 所以只比较正文部分；从未发布过则没有基线，允许发布第一版。
   */
  const skillDirtyVsPublished = useMemo(() => {
    if (!editBody.trim()) return false;
    const vs = detail?.versions ?? [];
    if (!vs.length) return true;
    const latest = vs.reduce((a, b) => (b.v > a.v ? b : a));
    return editBody !== bodyOfDoc(latest.content);
  }, [detail, editBody]);

  const composedPreview = (doc: SkillDoc) => {
    const fm = Object.entries(doc.frontmatter)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("\n");
    return fm ? `---\n${fm}\n---\n\n${doc.body}` : doc.body;
  };

  return (
    <PageShell
      title={t("nav.skills")}
      actions={
        <>
          <SearchBar value={query} onChange={setQuery} placeholder={t("skills.searchPlaceholder")} className="w-56" />
          <AddSkillDialog onDone={() => void loadSkills()} onImported={openTagForImported} />
          <Button variant="secondary" onClick={() => setScanOpen(true)}>
            <ScanSearch />
            {t("common.scan")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void runUpstreamCheck()}
            disabled={upstreamBusy || skills.length === 0}
            title={t("skills.upBatchHint")}
          >
            <UpstreamCheckIcon busy={upstreamBusy} />
            {t("skills.upBatchBtn")}
          </Button>
        </>
      }
    >
      <div className="mb-3 flex w-fit items-center gap-1 rounded-lg border border-border bg-surface p-0.5">
        {([
          { id: "skills" as const, label: t("nav.skills"), count: skills.length },
          { id: "tags" as const, label: t("tagShelf.title"), count: allTags.length },
        ]).map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={pageTab === item.id}
            onClick={() => setPageTab(item.id)}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11.5px] font-medium",
              pageTab === item.id ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
            )}
          >
            {item.label}
            <span className="font-mono text-[10px] opacity-60">{item.count}</span>
          </button>
        ))}
      </div>

      {pageTab === "tags" ? (
        <TagManagerView
          allTags={allTags}
          counts={tagCounts}
          resultCount={filtered.length}
        />
      ) : (
        <>
          <div className="flex min-h-0 flex-1 items-start gap-3">
            <aside className="w-[196px] shrink-0">
              <TagShelf
                variant="rail"
                allTags={allTags}
                counts={tagCounts}
                hideWhenEmpty={false}
                selected={activeTags}
                onChange={setActiveTags}
                mode={tagMode}
                onModeChange={setTagMode}
                onManage={() => setPageTab("tags")}
                onCommand={() => setTagCommandOpen(true)}
              />
              {skills.length > 0 ? (
                <HarnessFilterRail
                  reports={harnessReports}
                  counts={harnessCounts}
                  total={skills.length}
                  unassigned={unassignedCount}
                  value={harnessFilter}
                  onChange={setHarnessFilter}
                />
              ) : null}
            </aside>
            <div className="min-w-0 flex-1">
      {/* ── 预设栏（skill-presets）：页面内容最顶部，筛选与列表之上 ── */}
      <PresetBar
        presets={presets}
        selectedId={selectedPresetId}
        liveDirs={liveDirs}
        onSelect={setSelectedPresetId}
        onManage={() => {
          // 打开管理面板时重读一次：用户修好损坏的 presets.json 后无需重启即可恢复
          void loadPresets();
          setPresetManagerOpen(true);
        }}
      />


      {/* ── 吸顶筛选台：来源工具 · 标签 · 视图 · 批量 ── */}
      {skills.length > 0 ? (
        <div
          data-anim
          className="ah-material sticky top-0 z-20 mb-4 rounded-xl border border-border px-3 py-2.5"
        >
          {/* 第一行：结果计数 + 视图切换（来源筛选已删：一页里只服务一种来源，纯占地方） */}
          <div className="flex flex-wrap items-center gap-1.5">

            <span className="ml-auto flex shrink-0 items-center gap-2">
              <span className="tabular-nums text-[11px] text-ink-3">{t("skills.resultCount", { n: filtered.length })}</span>
              {hasFilter ? (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-ink-3 outline-none transition-colors hover:border-danger/40 hover:text-danger"
                >
                  <X className="size-3" />
                  {t("skills.clearFilters")}
                </button>
              ) : null}
              <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5">
                {(
                  [
                    { v: "grid", icon: LayoutGrid, key: "skills.viewGrid" },
                    { v: "tag", icon: Layers, key: "skills.viewGroup" },
                    { v: "tool", icon: Boxes, key: "skills.viewTool" },
                  ] as const
                ).map(({ v, icon: Icon, key }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setViewMode(v)}
                    title={t(key)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium outline-none transition-colors",
                      viewMode === v ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
                    )}
                  >
                    <Icon className="size-3.5" />
                    {t(key)}
                  </button>
                ))}
              </div>
            </span>
          </div>

          {/* 第二行：标签 + 批量操作 */}
          <div className="mt-2 flex flex-wrap items-start gap-2 border-t border-border/60 pt-2">

            {/*
              人因要点：切换键固定钉在这一行的右端，批量操作按钮出现在它左侧。
              因此「批量选择」按钮的位置在任何模式下都完全不变 ——
              快速连点不会被位移后的其它按钮（尤其是删除）命中。
            */}
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {batchMode ? (
                <>
                  {/* 全选 / 取消全选：作用于当前筛选结果 */}
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 w-[104px] justify-center text-[11px]"
                    disabled={filtered.length === 0}
                    onClick={() =>
                      setBatchSel((prev) =>
                        filtered.length > 0 && filtered.every((x) => prev.has(x.dirName))
                          ? new Set()
                          : new Set(filtered.map((x) => x.dirName)),
                      )
                    }
                  >
                    {filtered.length > 0 && filtered.every((x) => batchSel.has(x.dirName))
                      ? t("skills.batchUnselectAll")
                      : t("skills.batchSelectAll")}
                  </Button>

                  {/* 一步到位：生成 SKILL.toml（已接入自动跳过）+ 安全审查 */}
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 w-[136px] justify-center text-[11px]"
                    disabled={batchSel.size === 0 || onboardBusy}
                    onClick={() => void runOnboard()}
                  >
                    {onboardBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
                    {t("skills.onboardBtn")}
                  </Button>

                  {/* AI 摘要：选中的技能逐个生成（未选中时禁用） */}
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 w-[104px] justify-center text-[11px]"
                    disabled={batchSel.size === 0 || batchSummaryBusy}
                    onClick={() => void runBatchSummary()}
                  >
                    {batchSummaryBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                    {t("skills.batchSummaryBtn")}
                  </Button>

                  {/* 发版流水线：审查 → 摘要 → 打包，一条链跑完，每步可单独重跑 */}
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 w-[104px] justify-center text-[11px]"
                    disabled={batchSel.size === 0}
                    onClick={() => setPipelineOpen(true)}
                  >
                    <Play className="size-3.5" />
                    {t("skills.pipeBtn")}
                  </Button>

                  <span className="w-[76px] shrink-0 text-right tabular-nums text-[11px] text-ink-3">
                    {t("skills.batchSelectedShort", { n: batchSel.size })}
                  </span>

                  {/* 打包导出：按 SSEP §7.1 生成规范 .skillpack，并写 index.json */}
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 w-[104px] justify-center text-[11px]"
                    disabled={batchSel.size === 0 || packExport}
                    onClick={() => void runPack()}
                  >
                    {packExport ? <Loader2 className="size-3.5 animate-spin" /> : <Package className="size-3.5" />}
                    {t("skills.packExportBtn")}
                  </Button>

                  {/* 批量接入工具：选工具 → 一次复制 / 移除，按工具报成败 */}
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 w-[96px] justify-center text-[11px]"
                    disabled={batchSel.size === 0}
                    onClick={() => setHarnessBatchOpen(true)}
                  >
                    <Boxes className="size-3.5" />
                    {t("skills.harnessApplyBtn")}
                  </Button>

                  {/* 批量打标签：追加 / 移除 / 清空 */}
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 w-[96px] justify-center text-[11px]"
                    disabled={batchSel.size === 0}
                    onClick={() => {
                      setTagTargetDirs(null);
                      setBatchTagOpen(true);
                    }}
                  >
                    <Tag className="size-3.5" />
                    {t("skills.batchTagBtn")}
                  </Button>

                  {/* 保存为预设：把当前选中的技能写成一个命名集合 */}
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 w-[116px] justify-center text-[11px]"
                    disabled={batchSel.size === 0}
                    onClick={() => setPresetSaveOpen(true)}
                  >
                    <Layers className="size-3.5" />
                    {t("preset.saveAs")}
                  </Button>

                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 w-[84px] justify-center text-[11px]"
                    disabled={batchSel.size === 0 || batchStatusBusy}
                    onClick={() => void setBatchStatus("enabled")}
                  >
                    {batchStatusBusy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    {t("skills.batchEnable")}
                  </Button>

                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 w-[84px] justify-center text-[11px]"
                    disabled={batchSel.size === 0 || batchStatusBusy}
                    onClick={() => void setBatchStatus("disabled")}
                  >
                    {t("skills.batchDisable")}
                  </Button>

                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 w-[72px] justify-center text-[11px] text-danger hover:bg-danger/10 hover:text-danger"
                    disabled={batchSel.size === 0}
                    onClick={() => setBatchDeleteOpen(true)}
                  >
                    <Trash2 className="size-3.5" />
                    {t("skills.batchDelete")}
                  </Button>
                </>
              ) : null}

              {/* ← 位置锚点：这个按钮必须始终是这一行的最后一个元素 */}
              <Button
                size="sm"
                variant={batchMode ? "default" : "secondary"}
                className="h-7 w-[104px] justify-center text-[11px]"
                onClick={() => {
                  setBatchMode((v) => !v);
                  setBatchSel(new Set());
                }}
              >
                <ListChecks className="size-3.5" />
                {batchMode ? t("skills.batchExit") : t("skills.batchEnter")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {filtered.length === 0 && skills.length > 0 ? (
        <EmptyState
          icon={Sparkles}
          title={t("skills.noMatch")}
          hint={t("skills.noMatchHint")}
          action={
            hasFilter ? (
              <Button variant="secondary" onClick={clearFilters}>
                <X />
                {t("skills.clearFilters")}
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {skills.length === 0 ? (
        <div className="flex flex-col items-center gap-5 py-14">
          <div className="text-center">
            <Sparkles className="mx-auto size-6 text-ink-3" />
            <h3 className="mt-2 text-sm font-semibold text-foreground">{t("skills.emptyTitle")}</h3>
            <p className="mt-1 text-xs text-ink-3">{t("skills.emptyHint")}</p>
          </div>
          <div className="grid w-full max-w-2xl gap-2 sm:grid-cols-3">
            {(
              [
                { icon: Archive, title: t("skills.emptyPickZip"), hint: t("skills.emptyPickZipHint"), mode: "file" as const },
                { icon: FolderOpen, title: t("skills.emptyPickFolder"), hint: t("skills.emptyPickFolderHint"), mode: "file" as const },
                { icon: GitCompare, title: t("skills.emptyPickGit"), hint: t("skills.emptyPickGitHint"), mode: "git" as const },
              ] as const
            ).map(({ icon: Icon, title, hint, mode }) => (
              <button
                key={title}
                type="button"
                onClick={() => {
                  setAddMode(mode);
                  setAddOpen(true);
                }}
                className="flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-4 text-left outline-none transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
              >
                <span className="grid size-8 place-items-center rounded-lg bg-primary-soft text-primary">
                  <Icon className="size-4" />
                </span>
                <span className="text-[12.5px] font-semibold text-foreground">{title}</span>
                <span className="text-[11px] leading-snug text-ink-3">{hint}</span>
              </button>
            ))}
          </div>
          <Button onClick={() => setScanOpen(true)} variant="secondary">
            <ScanSearch />
            {t("common.scan")}
          </Button>
        </div>
      ) : filtered.length === 0 ? null : (
        (() => {
          const card = (s: SkillMeta) => {
            const hid = s.origin?.harness ?? "__local";
            const picked = batchSel.has(s.dirName);
            const attached = appliedMap.get(s.dirName) ?? [];
            return (
              <div
                key={s.dirName}
                data-anim
                onClick={() => (batchMode ? toggleBatch(s.dirName) : void openDetail(s))}
                className={cn(
                  "group flex cursor-pointer flex-col rounded-xl border border-border bg-card p-2.5 shadow-sm outline-none transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md",
                  picked && "border-primary shadow-[0_0_0_3px_var(--ah-primary-soft)]",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  {batchMode ? (
                    <span
                      className={cn(
                        "mt-0.5 grid size-5 shrink-0 place-items-center rounded border transition-colors",
                        picked ? "border-primary bg-primary text-white" : "border-border-strong",
                      )}
                    >
                      {picked ? <Check className="size-3.5" strokeWidth={3} /> : null}
                    </span>
                  ) : null}
                  <h3 className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-semibold text-foreground">{s.name}</h3>
                  {s.origin ? (
                    <Badge variant="muted" title={s.origin.file} className="shrink-0">
                      <HarnessIcon id={hid} />
                      {HARNESS_LABEL[hid] ?? hid}
                    </Badge>
                  ) : (
                    <Badge variant="muted" className="shrink-0">
                      {t("skills.srcLocal")}
                    </Badge>
                  )}
                </div>
                {s.description ? (
                  <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-ink-2">{s.description}</p>
                ) : null}
                {/* AI 摘要：有摘要时给一行速览，没有则不占位（详情页有生成入口） */}
                {s.summary ? (
                  <p
                    className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-ink-3"
                    title={`${s.summary.domain} · ${s.summary.oneLiner}`}
                  >
                    <span className="font-medium text-primary">{s.summary.domain}</span>
                    <span> · </span>
                    {s.summary.oneLiner}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {s.tags.map((tg) => {
                    const on = activeTags.has(tg);
                    return (
                      <button
                        key={tg}
                        type="button"
                        disabled={batchMode}
                        title={batchMode ? undefined : t("skills.tagDrillHint")}
                        onClick={(e) => {
                          e.stopPropagation();
                          drillTag(tg);
                        }}
                        className={cn("rounded-full outline-none transition-colors", !batchMode && "hover:-translate-y-px")}
                      >
                        <Badge variant={on ? "default" : "muted"} className={cn(on && "ring-1 ring-primary/40")}>
                          {tg}
                        </Badge>
                      </button>
                    );
                  })}
                  {s.hasAssets ? (
                    <Badge variant="outline" title={t("skills.hasAssets")}>
                      <Paperclip />
                      {t("skills.assetBadge")}
                    </Badge>
                  ) : null}
                  {/* 协议状态：未接入时显式标出，方便批量挑出来处理 */}
                  {s.hasToml ? (
                    s.version !== "0.0.0" ? (
                      <Badge variant="info" title={t("skills.protoVersionHint")}>
                        v{s.version}
                      </Badge>
                    ) : null
                  ) : (
                    <Badge variant="warning" title={t("skills.noProtoHint")}>
                      <CircleAlert />
                      {t("skills.noProto")}
                    </Badge>
                  )}
                  {s.hasToml && s.status !== "active" ? <Badge variant="warning">{s.status}</Badge> : null}
                  {s.stale ? <Badge variant="danger">STALE</Badge> : null}
                  {/* 安全审查：待复核条数醒目提示；已批准则显示绿标 */}
                  {s.vetPending > 0 ? (
                    <Badge variant="warning" title={t("skills.reviewPendingHint")}>
                      <ShieldAlert />
                      {t("skills.reviewPending", { n: s.vetPending })}
                    </Badge>
                  ) : s.vetVerdict && s.vetPending === 0 && s.vetIgnored > 0 ? (
                    <Badge variant="success" title={t("skills.reviewOkHint")}>
                      <ShieldCheck />
                      {t("skills.reviewOk")}
                    </Badge>
                  ) : s.vetVerdict === "REJECT" ? (
                    <Badge variant="danger" title={t("skills.reviewRejectHint")}>
                      <ShieldAlert />
                      {t("skills.vetReject")}
                    </Badge>
                  ) : null}
                  {/* 版本快照数量：0 条时弱化，但仍可见（便于发现「没纳入版本管理」） */}
                  <Badge variant={s.versions > 0 ? "muted" : "outline"} title={t("skills.histCountHint")}>
                    <History />
                    {s.versions > 0 ? s.versions : t("skills.histNone")}
                  </Badge>
                </div>

                {/* 工具维度：接了哪些 harness —— 这是「删不删」最直接的依据 */}
                {harnessReports ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px] text-ink-3">
                    {attached.length === 0 ? (
                      <span className="inline-flex items-center gap-1">
                        <CircleAlert className="size-2.5" />
                        {t("skills.harnessNone")}
                      </span>
                    ) : (
                      <>
                        <span>{t("skills.harnessConnected")}</span>
                        {attached.slice(0, 3).map((r) => {
                          const at = lastAppliedAt([r], s);
                          return (
                            <span
                              key={r.id}
                              title={at > 0 ? `${r.name} · ${fmtTime(new Date(at).toISOString())}` : r.name}
                              className="inline-flex items-center gap-0.5 rounded-full border border-border bg-surface/60 px-1.5 py-px text-ink-2"
                            >
                              <HarnessIcon id={r.id} className="size-2.5" />
                              {shortHarnessName(r.name)}
                            </span>
                          );
                        })}
                        {attached.length > 3 ? <span className="font-mono">+{attached.length - 3}</span> : null}
                      </>
                    )}
                  </div>
                ) : null}

                {/* 底部行：更新时间为常态信息，动作按钮固定在右下角（整列对齐） */}
                <div className="mt-auto flex items-center gap-1 border-t border-border/60 pt-2.5">
                  <span className="min-w-0 flex-1 truncate text-[11px] text-ink-3" title={fmtTime(s.updatedAt)}>
                    {t("skills.updatedAt")} {fmtTime(s.updatedAt)}
                  </span>
                  {batchMode ? null : (
                    <>
                      <Button
                        size="iconSm"
                        variant="ghost"
                        className="text-ink-3/70 hover:text-foreground"
                        title={t("common.reveal")}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (dataDirs) void api.revealPath(`${dataDirs.skills}\\${s.dirName}`);
                        }}
                      >
                        <FolderOpen />
                      </Button>
                      <Button
                        size="iconSm"
                        variant="ghost"
                        className="text-ink-3/70 hover:bg-danger/10 hover:text-danger"
                        title={t("common.delete")}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleting(s);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          };

          if (viewMode === "tag" && grouped) {
            return (
              <div className="flex flex-col gap-4">
                {grouped.map(([tag, list]) => {
                  const collapsed = collapsedTags.has(tag);
                  return (
                    <section key={tag} className="flex flex-col gap-2.5 rounded-xl border border-border bg-surface/40 p-3">
                      <h2
                        onClick={() => toggleGroup(tag)}
                        className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3 outline-none transition-colors hover:text-foreground"
                      >
                        <ChevronRight className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")} />
                        <Tag className="size-3.5" />
                        {tag}
                        <span className="rounded-full bg-surface-2 px-1.5 py-px font-mono tabular-nums">{list.length}</span>
                        {list[0]?.tags.includes(tag) ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              drillTag(tag);
                            }}
                            className="ml-1 text-[10px] font-normal normal-case tracking-normal text-primary outline-none hover:underline"
                          >
                            {activeTags.has(tag) ? t("skills.tagOnlyOff") : t("skills.tagOnly")}
                          </button>
                        ) : null}
                      </h2>
                      {collapsed ? null : <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2">{list.map(card)}</div>}
                    </section>
                  );
                })}
              </div>
            );
          }
          if (viewMode === "tool" && groupedByTool) {
            return (
              <div className="flex flex-col gap-4">
                {groupedByTool.map(([id, list]) => {
                  const report = skillHarnesses.find((r) => r.id === id);
                  const collapsed = collapsedTools.has(id);
                  return (
                    <section key={id} className="flex flex-col gap-2.5 rounded-xl border border-border bg-surface/40 p-3">
                      <h2
                        onClick={() => toggleToolGroup(id)}
                        className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3 outline-none transition-colors hover:text-foreground"
                      >
                        <ChevronRight className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")} />
                        {id === "__none" ? <CircleSlash className="size-3.5" /> : <HarnessIcon id={id} className="size-3.5" />}
                        {id === "__none" ? t("skills.toolsNone") : (report?.name ?? id)}
                        <span className="rounded-full bg-surface-2 px-1.5 py-px font-mono tabular-nums">{list.length}</span>
                      </h2>
                      {collapsed ? null : <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2">{list.map(card)}</div>}
                    </section>
                  );
                })}
              </div>
            );
          }
          return <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2">{filtered.map(card)}</div>;
        })()
      )}

      {/* detail */}
      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent wide className="h-[90vh] sm:max-w-6xl">
          {detail ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 font-mono">
                  <Sparkles className="size-4 text-primary" />
                  {detail.meta.name}
                </DialogTitle>
                <DialogDescription className="font-mono" dir="ltr">
                  {t("skills.dirName")}: {detail.meta.dirName} · {detail.meta.contentLen} chars
                </DialogDescription>
                {/* 接入情况与最近同步时间：判断「能不能删」的第一手依据 */}
                {harnessReports ? (
                  (() => {
                    const attached = appliedMap.get(detail.meta.dirName) ?? [];
                    return (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10.5px] text-ink-3">
                        {attached.length === 0 ? (
                          <span>{t("skills.harnessNeverApplied")}</span>
                        ) : (
                          <>
                            <span>{t("skills.harnessConnected")}</span>
                            {attached.map((r) => {
                              const at = lastAppliedAt([r], detail.meta);
                              return (
                                <span
                                  key={r.id}
                                  className="inline-flex items-center gap-1 rounded-full border border-border bg-surface/60 px-1.5 py-0.5 text-ink-2"
                                >
                                  <HarnessIcon id={r.id} className="size-3" />
                                  {r.name}
                                  {at > 0 ? <span className="text-ink-3">· {fmtTime(new Date(at).toISOString())}</span> : null}
                                </span>
                              );
                            })}
                          </>
                        )}
                      </div>
                    );
                  })()
                ) : null}
              </DialogHeader>

              <div className="border-b border-border px-5 pt-3">
                <Tabs value={tab} onValueChange={handleTab} variant="segment">
                  <TabsList>
                    <TabsTrigger value="content">{t("skills.tabContent")}</TabsTrigger>
                    <TabsTrigger value="files">{t("skills.tabFiles")}</TabsTrigger>
                    <TabsTrigger value="proto">{t("skills.protoTab")}</TabsTrigger>
                    <TabsTrigger value="review">
                      {t("skills.tabReview")}
                      {detail.meta.vetPending > 0 ? (
                        <span className="ml-1.5 rounded-full bg-warning/15 px-1.5 py-px text-[10px] font-medium tabular-nums text-warning">
                          {detail.meta.vetPending}
                        </span>
                      ) : null}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>

              {/* 两栏各自滚动：DialogBody 默认整块滚动会连带把右栏拖走，这里改成 overflow-hidden */}
              <DialogBody className="flex min-h-0 flex-row gap-4 overflow-hidden">
                {detailLoading ? (
                  <div className="grid h-full w-full place-items-center text-xs text-ink-3">{t("common.loading")}</div>
                ) : (
                  <Tabs value={tab} onValueChange={handleTab} className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <TabsContent value="content" className="flex min-h-0 flex-1 flex-col">
                      <form
                        id="skill-edit-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void handleEditSave();
                        }}
                        className="flex min-h-0 flex-1 flex-col gap-4"
                      >
                        {contentMode !== "preview" ? (
                          <div className="flex shrink-0 flex-col gap-4">
                            <Field label={t("skills.fieldName")}>
                              <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="font-mono" />
                            </Field>
                            <Field label={t("common.description")}>
                              <Textarea value={editDesc} onChange={(e) => setEditDesc(e.target.value)} className="min-h-16 resize-y" />
                            </Field>
                            <Field label={t("common.tags")}>
                              <TagPicker value={editTags} onChange={setEditTags} allTags={allTags} />
                            </Field>
                          </div>
                        ) : null}

                        <Field label={t("skills.fieldBody")} className="flex min-h-0 flex-1 flex-col">
                          {/* 工具栏：左侧三态切换，右侧暂存 / 发布（与提示词编辑器同一套） */}
                          <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2">
                            <div className="flex w-fit items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5">
                              {(
                                [
                                  { m: "preview", icon: Eye, key: "skills.modePreview" },
                                  { m: "edit", icon: Pencil, key: "skills.modeEdit" },
                                  { m: "split", icon: Columns2, key: "skills.modeSplit" },
                                ] as const
                              ).map(({ m, icon: Icon, key }) => (
                                <button
                                  key={m}
                                  type="button"
                                  onClick={() => setContentMode(m)}
                                  className={cn(
                                    "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium outline-none transition-colors",
                                    contentMode === m ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
                                  )}
                                >
                                  <Icon className="size-3.5" />
                                  {t(key)}
                                </button>
                              ))}
                            </div>

                            <div className="ml-auto flex items-center gap-2">
                              {/* 变更级别：协议要求，只影响发布时的版本号递增 */}
                              <Select value={editLevel} onValueChange={setEditLevel}>
                                <SelectTrigger className="h-8 w-[104px] text-[11px]" title={t("skills.saveLevelHint")}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="L1">L1 · {t("skills.levelL1")}</SelectItem>
                                  <SelectItem value="L2">L2 · {t("skills.levelL2")}</SelectItem>
                                  <SelectItem value="L3">L3 · {t("skills.levelL3")}</SelectItem>
                                  <SelectItem value="L4">L4 · {t("skills.levelL4")}</SelectItem>
                                </SelectContent>
                              </Select>
                              {/* 暂存：只落盘，不产生版本记录 */}
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                disabled={busy || !skillDirty || !editName.trim()}
                                onClick={() => void handleEditSave(false)}
                              >
                                <Archive className="size-3.5" />
                                {t("prompts.stash")}
                              </Button>
                              {/* 发布：正文相对已发布版本有变动才允许 */}
                              <Button
                                type="button"
                                size="sm"
                                disabled={busy || !skillDirtyVsPublished || !editName.trim()}
                                onClick={() => void handleEditSave(true)}
                              >
                                <CloudUpload className="size-3.5" />
                                {t("prompts.publish")}
                              </Button>
                            </div>
                          </div>
                          {contentMode === "preview" ? (
                            <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-bg-subtle p-4">
                              <Markdown source={composedPreview(detail)} />
                            </div>
                          ) : contentMode === "edit" ? (
                            <Textarea
                              value={editBody}
                              onChange={(e) => setEditBody(e.target.value)}
                              spellCheck={false}
                              className="h-full min-h-0 flex-1 resize-none overflow-y-auto font-mono text-[13px]"
                            />
                          ) : (
                            <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
                              <Textarea
                                value={editBody}
                                onChange={(e) => setEditBody(e.target.value)}
                                spellCheck={false}
                                className="h-full min-h-0 resize-none overflow-y-auto font-mono text-[13px]"
                              />
                              <div className="min-h-0 overflow-y-auto rounded-lg border border-border bg-bg-subtle p-4">
                                <Markdown source={editBody} />
                              </div>
                            </div>
                          )}
                        </Field>
                      </form>
                    </TabsContent>

                    <TabsContent value="files" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
                      <SkillFileBrowser dirName={detail.meta.dirName} />
                    </TabsContent>
                    <TabsContent value="review" className="min-h-0 flex-1 overflow-y-auto">
                      <VetReviewPanel
                        dirName={detail.meta.dirName}
                        onChanged={() => {
                          void loadSkills();
                          if (detail) {
                            const meta = skills.find((s) => s.dirName === detail.meta.dirName);
                            if (meta) void openDetail(meta);
                          }
                        }}
                      />
                    </TabsContent>
                    <TabsContent value="proto" className="min-h-0 flex-1 overflow-y-auto">
                      {protoLoading || !proto ? (
                        <div className="grid place-items-center py-16 text-xs text-ink-3">{t("common.loading")}</div>
                      ) : (
                        <div className="flex flex-col gap-4 pb-1">
                          {/* ── 未接入协议：醒目提示 ── */}
                          {!proto.hasToml ? (
                            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3">
                              <Sparkles className="size-4 shrink-0 text-warning" />
                              <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink-2">{t("skills.protoNoToml")}</p>
                              <Button size="sm" variant="secondary" className="shrink-0" disabled={busy} onClick={() => void generateProto()}>
                                {t("skills.protoGenerate")}
                              </Button>
                            </div>
                          ) : null}

                          {/* ── 概览头：版本 / 状态 / 新鲜度 / 安全结论 ── */}
                          {proto.doc ? (() => {
                            const doc = proto.doc as
                              | {
                                  meta?: { version?: string; status?: string; summary?: string };
                                  vet?: { verdict?: string; critical?: number; high?: number; medium?: number };
                                }
                              | null;
                            const meta = doc?.meta;
                            const vet = doc?.vet;
                            const st = meta?.status ?? "draft";
                            const stKey = st === "active" ? "skills.stateActive" : st === "deprecated" ? "skills.stateDeprecated" : st === "archived" ? "skills.stateArchived" : "skills.stateDraft";
                            const bad = (vet?.critical ?? 0) + (vet?.high ?? 0);
                            const verdict = !vet
                              ? t("skills.vetNever")
                              : vet.verdict === "REJECT"
                                ? t("skills.vetReject")
                                : bad > 0
                                  ? t("skills.vetReview", { n: bad })
                                  : t("skills.vetPass");
                            const verdictTone = !vet ? "text-ink-3" : vet.verdict === "REJECT" ? "text-danger" : bad > 0 ? "text-warning" : "text-success";
                            return (
                              <div className="rounded-xl border border-border bg-card p-4">
                                <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
                                  <div className="flex min-w-0 flex-1 items-center gap-3">
                                    <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
                                      <Package className="size-5" />
                                    </span>
                                    <div className="min-w-0">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-mono text-lg font-semibold leading-none text-foreground" title={t("skills.verExplain")}>
                                          v{meta?.version ?? "0.0.0"}
                                        </span>
                                        <Badge variant={st === "active" ? "success" : "warning"}>{t(stKey)}</Badge>
                                        {proto.stale ? (
                                          <Badge variant="danger" className="bg-danger/12 text-danger" title={t("skills.vetRuleStale")}>
                                            <CircleAlert />
                                            {t("skills.staleWarn")}
                                          </Badge>
                                        ) : proto.hasToml ? (
                                          <Badge variant="muted">{t("skills.freshOk")}</Badge>
                                        ) : null}
                                      </div>
                                      <p className="mt-1.5 truncate text-[11px] text-ink-3">{t("skills.protoIntro")}</p>
                                    </div>
                                  </div>

                                  <div className="flex shrink-0 items-center gap-3 rounded-lg border border-border bg-bg-subtle px-3 py-2">
                                    <ShieldCheck className={cn("size-4 shrink-0", verdictTone)} />
                                    <div className="min-w-0">
                                      <div className="text-[10px] font-medium uppercase tracking-wider text-ink-3">{t("skills.vetTitle")}</div>
                                      <div className={cn("whitespace-nowrap text-xs font-medium", verdictTone)}>{verdict}</div>
                                    </div>
                                    <Button
                                      size="iconSm"
                                      variant="ghost"
                                      title={t("skills.vetRerun")}
                                      onClick={() => detail && void api.vetSkill(detail.meta.dirName).then((r) => { toast.success(t("skills.protoVetDone", { verdict: r.verdict })); void loadProto(detail.meta.dirName); }).catch((e) => toast.error(String(e)))}
                                    >
                                      <RotateCw className="size-3.5" />
                                    </Button>
                                  </div>
                                </div>

                                {proto.violations.length ? (
                                  <div className="mt-3 flex flex-col gap-1 border-t border-border pt-3">
                                    {proto.violations.map((v) => (
                                      <div
                                        key={v.rule + v.message}
                                        className={cn(
                                          "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
                                          v.severity === "error"
                                            ? "border-danger/30 bg-danger/10 text-danger"
                                            : v.severity === "warning"
                                              ? "border-warning/30 bg-warning/10 text-warning"
                                              : "border-border bg-bg-subtle text-ink-3",
                                        )}
                                      >
                                        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
                                        <span className="min-w-0">
                                          {VET_RULE_KEY[v.rule] ? t(`skills.${VET_RULE_KEY[v.rule]}`) : v.message}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })() : null}

                          {/* ── 元信息：来源与更新 + 运行要求 ── */}
                          {proto.doc ? (
                            <>
                              <CollapsibleCard icon={GitCompare} title={t("skills.srcTitle")}>
                            <div className="flex flex-col gap-3">
                              <div className="flex items-center justify-between gap-2">
                                                                  <div className="flex items-center gap-1.5">
                                                                    <GitCompare className="size-3.5 text-ink-3" />
                                                                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{t("skills.srcTitle")}</h3>
                                                                  </div>
                                                                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => detail && void api.checkUpstream(detail.meta.dirName).then((r) => { if (r.changed) toast.warning(t("skills.upstreamChanged")); else toast.info(r.note); }).catch((e) => toast.error(String(e)))}>
                                                                    <RefreshCw className="size-3.5" />
                                                                    {t("skills.upCheck")}
                                                                  </Button>
                                                                </div>
                                                                <Field label={t("skills.srcKind")}>
                                                                  <Input
                                                                    value={extUpstream.watch ? t("skills.srcWatched") : t("skills.srcManual")}
                                                                    readOnly
                                                                    className="h-8 bg-bg-subtle"
                                                                  />
                                                                </Field>
                                                                <Field label={t("skills.upRemote")} hint={t("skills.upHint")}>
                                                                  <Input
                                                                    value={extUpstream.remote}
                                                                    onChange={(e) => setExtUpstream((u) => ({ ...u, remote: e.target.value }))}
                                                                    placeholder="https://github.com/…"
                                                                    className="h-8 font-mono text-xs"
                                                                  />
                                                                </Field>
                                                                <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2">
                                                                  <Switch checked={extUpstream.watch} onCheckedChange={(v) => setExtUpstream((u) => ({ ...u, watch: v }))} />
                                                                  <span className="text-xs text-ink-2">{t("skills.upWatch")}</span>
                                                                </div>
                            </div>
                          </CollapsibleCard>

                          <CollapsibleCard icon={Settings2} title={t("skills.rtTitle")}>
                            <div className="flex flex-col gap-3">
                              <div className="flex items-center gap-1.5">
                                                                  <Settings2 className="size-3.5 text-ink-3" />
                                                                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{t("skills.rtTitle")}</h3>
                                                                </div>
                                                                <Field label={t("skills.rtScripts")} hint={t("skills.rtScriptsHint")}>
                                                                  <Select value={extRuntime.requires_scripts} onValueChange={(v) => setExtRuntime((r) => ({ ...r, requires_scripts: v }))}>
                                                                    <SelectTrigger className="h-8">
                                                                      <SelectValue />
                                                                    </SelectTrigger>
                                                                    <SelectContent>
                                                                      <SelectItem value="none">{t("skills.rtOptNone")}</SelectItem>
                                                                      <SelectItem value="optional">{t("skills.rtOptOptional")}</SelectItem>
                                                                      <SelectItem value="required">{t("skills.rtOptRequired")}</SelectItem>
                                                                    </SelectContent>
                                                                  </Select>
                                                                </Field>
                                                                <Field label={t("skills.rtNetwork")}>
                                                                  <Select value={extRuntime.requires_network} onValueChange={(v) => setExtRuntime((r) => ({ ...r, requires_network: v }))}>
                                                                    <SelectTrigger className="h-8">
                                                                      <SelectValue />
                                                                    </SelectTrigger>
                                                                    <SelectContent>
                                                                      <SelectItem value="none">{t("skills.rtOptNone")}</SelectItem>
                                                                      <SelectItem value="optional">{t("skills.rtOptOptional")}</SelectItem>
                                                                      <SelectItem value="required">{t("skills.rtOptRequired")}</SelectItem>
                                                                    </SelectContent>
                                                                  </Select>
                                                                </Field>
                            </div>
                              </CollapsibleCard>
                            </>
                          ) : null}

                          {/* ── 依赖关系（可视化 + 编辑） ── */}
                          <CollapsibleCard icon={Boxes} title={t("skills.depsTitle")}>
                            <p className="mt-1 text-[11px] text-ink-3">{t("skills.depsHint")}</p>
                            <div className="mt-3">
                              {(() => {
                                const deps = (proto.doc as { deps?: { item?: { name?: string; semver?: string; reason?: string }[] } } | null)?.deps?.item ?? [];
                                if (!deps.length) {
                                  return <p className="rounded-lg bg-bg-subtle px-3 py-2.5 text-xs text-ink-2">{t("skills.depsNone")}</p>;
                                }
                                return (
                                  <div className="flex flex-col gap-2">
                                    {deps.map((d, i) => {
                                      const name = d.name ?? "";
                                      const installed = skills.find((x) => x.dirName === name || x.name === name);
                                      const have = installed?.version ?? "";
                                      const sat = installed ? semverSatisfies(have, d.semver ?? "") : false;
                                      return (
                                        <div key={i} className="rounded-lg border border-border bg-bg-subtle px-3 py-2">
                                          <div className="flex flex-wrap items-center gap-2">
                                            <span className="rounded-lg border border-primary/40 bg-primary-soft px-2 py-1 font-mono text-xs font-medium text-primary">
                                              {detail?.meta.name}
                                            </span>
                                            <span className="flex items-center gap-1 text-[11px] text-ink-3">
                                              {t("skills.depNeed")}
                                              <ArrowRight className="size-3" />
                                            </span>
                                            <span
                                              className={cn(
                                                "rounded-lg border px-2 py-1 font-mono text-xs",
                                                installed
                                                  ? sat
                                                    ? "border-success/40 bg-success/10 text-success"
                                                    : "border-warning/40 bg-warning/10 text-warning"
                                                  : "border-danger/40 bg-danger/10 text-danger",
                                              )}
                                            >
                                              {name} {d.semver ? <span className="opacity-70">{d.semver}</span> : null}
                                            </span>
                                            <span className="ml-auto">
                                              {installed ? (
                                                sat ? (
                                                  <Badge variant="success">{t("skills.depInstalled")} · {t("skills.depVersionOk")}</Badge>
                                                ) : (
                                                  <Badge variant="warning">{t("skills.depVersionBad")}（{t("skills.depHave")} v{have}）</Badge>
                                                )
                                              ) : (
                                                <Badge variant="danger" className="bg-danger/12 text-danger">{t("skills.depMissing")}</Badge>
                                              )}
                                            </span>
                                          </div>
                                          {d.reason ? <p className="mt-1 text-[11px] text-ink-3">↳ {d.reason}</p> : null}
                                        </div>
                                      );
                                    })}
                                  </div>
                                );
                              })()}
                            </div>

                            {/* 依赖编辑（折叠） */}
                            <details className="group mt-3 border-t border-border pt-3">
                              <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 py-0.5 text-[11px] font-medium text-ink-3 outline-none transition-colors hover:text-foreground">
                                <Pencil className="size-3" />
                                {t("skills.depsEdit")}
                                <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
                              </summary>
                              <div className="mt-2 flex flex-col gap-1.5">
                                {extDeps.map((d, i) => (
                                  <div key={i} className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-subtle p-1.5">
                                    <SkillPicker
                                      value={d.name}
                                      options={skills.map((sk) => sk.name)}
                                      exclude={detail?.meta.name}
                                      placeholder={t("skills.depName")}
                                      onSelect={(n) =>
                                        setExtDeps((arr) => arr.map((x, j) => (j === i ? { ...x, name: n } : x)))
                                      }
                                    />
                                    <Input
                                      value={d.semver}
                                      onChange={(e) => setExtDeps((arr) => arr.map((x, j) => (j === i ? { ...x, semver: e.target.value } : x)))}
                                      placeholder="≥1.0"
                                      className="h-7 w-24 font-mono text-xs"
                                    />
                                    <Button size="iconSm" variant="ghost" onClick={() => setExtDeps((arr) => arr.filter((_, j) => j !== i))}>
                                      <Trash2 />
                                    </Button>
                                  </div>
                                ))}
                                <Button size="sm" variant="ghost" className="h-7 w-fit px-2 text-[11px]" onClick={() => setExtDeps((d) => [...d, { name: "", semver: ">=1.0", reason: "" }])}>
                                  <Plus className="!size-3" />
                                  {t("common.new")}
                                </Button>
                              </div>
                            </details>
                          </CollapsibleCard>

                          {/* ── 生命周期状态：标记技能处于哪个阶段（组织用途） ── */}
                          <CollapsibleCard icon={Zap} title={t("skills.actTitle")}>

                            <p className="mt-2 text-[11px] leading-relaxed text-ink-3">{t("skills.actHint")}</p>

                            {/* 状态切换：只影响「标记」，不改变技能内容 */}
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              <Button size="sm" onClick={() => void applyStatus("active")}>{t("skills.actEnable")}</Button>
                              <Button size="sm" variant="secondary" onClick={() => void applyStatus("draft")}>{t("skills.actDraft")}</Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-danger/40 text-danger hover:bg-danger/10 hover:text-danger"
                                onClick={() => void applyStatus("deprecated")}
                              >
                                {t("skills.actDisable")}
                              </Button>
                            </div>

                            {/* 单个打包：与列表里的批量打包同一套规范校验 */}
                            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                              <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-ink-3">{t("skills.packSpec")}</span>
                              <Button size="sm" variant="secondary" className="shrink-0" onClick={() => void handlePack()}>
                                <Package className="size-3.5" />
                                {t("skills.protoPack")}
                              </Button>
                            </div>
                          </CollapsibleCard>

                          {/* ── 变更记录 ── */}
                          <CollapsibleCard icon={Clock} title={t("skills.logTitle")}>
                            <div className="mt-3 flex max-h-72 flex-col gap-1 overflow-y-auto pr-1">
                              {(() => {
                                const events = (proto.doc as { lifecycle?: { event?: { at?: string; action?: string; level?: string; note?: string }[] } } | null)?.lifecycle?.event ?? [];
                                if (!events.length) return <p className="text-[11px] text-ink-3">{t("skills.logEmpty")}</p>;
                                return [...events].reverse().slice(0, 20).map((ev, i) => {
                                  const zhKey = LIFECYCLE_ZH_KEY[ev.action ?? ""];
                                  return (
                                    <div key={i} className="flex items-center gap-2 rounded-lg bg-bg-subtle px-2.5 py-1.5 text-[11px]">
                                      <Badge
                                        variant={
                                          ev.action === "update"
                                            ? "info"
                                            : ev.action === "create" || ev.action === "import" || ev.action === "active"
                                              ? "success"
                                              : ev.action === "deprecated" || ev.action === "archived"
                                                ? "warning"
                                                : "muted"
                                        }
                                      >
                                        {zhKey ? t(`skills.${zhKey}`) : ev.action}
                                      </Badge>
                                      {ev.level ? <code className="font-mono text-[10px] text-primary">{ev.level}</code> : null}
                                      <span className="min-w-0 flex-1 truncate text-ink-2">{ev.note}</span>
                                      <span className="shrink-0 tabular-nums text-ink-3">{fmtTime(ev.at)}</span>
                                    </div>
                                  );
                                });
                              })()}
                            </div>
                          </CollapsibleCard>

                          {/* ── 统一保存：来源与更新 / 运行要求 / 依赖技能 ── */}
                          <div className="sticky bottom-0 z-10 flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-2.5 shadow-md">
                            <span className="min-w-0 truncate text-[11px] text-ink-3">
                              {t("skills.srcTitle")} · {t("skills.rtTitle")} · {t("skills.depsTitle")}
                            </span>
                            <Button size="sm" className="shrink-0" onClick={() => void saveExt()} disabled={extSaving}>
                              <Save className="size-3.5" />
                              {extSaving ? t("common.saving") : t("common.save")}
                            </Button>
                          </div>
                        </div>
                      )}
                    </TabsContent>
                  </Tabs>
                )}

                {/* 右栏：AI 摘要（默认折叠）在上，版本时间轴在下 —— 时间轴位置不动。 */}
                {!detailLoading ? (
                  <aside className="flex w-[320px] shrink-0 flex-col gap-2">
                    {detail ? (
                      <SkillSummaryPanel
                        summary={detail.meta.summary ?? null}
                        busy={summaryBusy}
                        onGenerate={() => void generateSummary(detail.meta.dirName)}
                      />
                    ) : null}
                    <VersionList
                      fill
                      versions={detail?.versions ?? []}
                      current={editBody}
                      onSeed={
                        detail
                          ? () =>
                              void api
                                .seedSkillVersion(detail.meta.dirName, t("skills.seedVersionNote"))
                                .then((created) => {
                                  toast[created ? "success" : "info"](t(created ? "skills.seedVersionDone" : "skills.seedVersionSkip"));
                                  return api.readSkill(detail.meta.dirName);
                                })
                                .then((doc) => setDetail(doc))
                                .catch((e) => toast.error(String(e)))
                          : undefined
                      }
                      onClear={detail ? () => setClearVerOpen(true) : undefined}
                      onRestore={(content) => {
                        // 版本快照是整份 SKILL.md；去掉 frontmatter 后填回正文
                        setEditBody(bodyOfDoc(content));
                        setTab("content");
                        setContentMode("edit");
                        toast.info(t("skills.versionRestored"));
                      }}
                    />
                  </aside>
                ) : null}
              </DialogBody>

              <DialogFooter>
                {tab === "content" && contentMode !== "preview" ? (
                  <Button type="submit" form="skill-edit-form" disabled={!editName.trim()}>
                    {t("common.save")}
                  </Button>
                ) : null}
                <Button variant="secondary" onClick={() => setDetail(null)}>
                  {t("common.close")}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <HarnessDialog open={scanOpen} onOpenChange={setScanOpen} kind="skills" />

      <HarnessBatchDialog
        open={harnessBatchOpen}
        onOpenChange={setHarnessBatchOpen}
        kind="skills"
        items={skills
          .filter((s) => batchSel.has(s.dirName))
          .map((s) => ({ key: s.dirName, applied: (appliedMap.get(s.dirName) ?? []).map((r) => r.id) }))}
        reports={skillHarnesses}
        run={(hid, mode, keys) =>
          mode === "apply" ? api.applyToHarness(hid, "skills", keys) : api.removeFromHarness(hid, "skills", keys)
        }
        onDone={loadHarnesses}
      />

      <AddSkillDialog
        onDone={() => void loadSkills()}
        onImported={openTagForImported}
        open={addOpen}
        onOpenChange={setAddOpen}
        initialMode={addMode}
      />

      <SkillPipelineDialog
        open={pipelineOpen}
        onOpenChange={setPipelineOpen}
        count={batchSel.size}
        outDir={pipelineOutDir}
        onPickOutDir={pickPipelineOutDir}
        runStep={runPipelineStep}
      />
      <UpstreamCheckDialog
        open={upstreamOpen}
        onOpenChange={setUpstreamOpen}
        rows={upstreamRows}
        onOpenSkill={(dirName) => {
          const meta = skills.find((item) => item.dirName === dirName);
          if (!meta) return;
          setUpstreamOpen(false);
          void openDetail(meta);
        }}
      />
      <BatchTagDialog
        open={batchTagOpen}
        onOpenChange={(v) => {
          setBatchTagOpen(v);
          if (!v) setTagTargetDirs(null);
        }}
        count={tagTargetDirs?.length ?? batchSel.size}
        allTags={allTags}
        onApply={applyTagsToSelection}
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

      {/* ── 保存为预设（skill-presets） ── */}
      <PresetDialog
        open={presetSaveOpen}
        onOpenChange={setPresetSaveOpen}
        title={t("preset.createTitle")}
        hint={t("preset.saveAsHint", { n: batchSel.size })}
        onSubmit={async (name, description) => {
          try {
            const p = await api.presetCreate(name, description, [...batchSel]);
            toast.success(t("preset.created", { name: p.name }));
          } catch (e) {
            throw presetErrorText(e, t);
          }
          setBatchSel(new Set());
          await loadPresets();
        }}
      />

      {/* ── 预设管理面板 ── */}
      <PresetManager
        open={presetManagerOpen}
        onOpenChange={setPresetManagerOpen}
        presets={presets}
        skills={skills}
        onChanged={loadPresets}
        onDeleted={(id) => setSelectedPresetId((cur) => (cur === id ? null : cur))}
      />



      <ConfirmDialog
        open={clearVerOpen}
        onOpenChange={setClearVerOpen}
        title={t("settings.vaultClearTitle")}
        message={t("settings.vaultClearMsg")}
        danger
        onConfirm={() => {
          if (!detail) return;
          void api
            .clearSkillVersions(detail.meta.dirName)
            .then((n) => {
              toast.success(t("skills.versionsCleared", { n }));
              setDetail({ ...detail, versions: [] });
            })
            .catch((e) => toast.error(String(e)));
        }}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={t("skills.deleteConfirmTitle")}
        message={t("skills.deleteConfirmMsg", { name: deleting?.name ?? "" })}
        danger
        onConfirm={() => {
          if (deleting) void deleteSkill(deleting.dirName).then(() => toast.success(t("skills.deleted")));
        }}
      />

      {/* ── 打包导出结果 ── */}
      <Dialog open={!!packReport} onOpenChange={(v) => !v && setPackReport(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="size-4 text-primary" />
              {t("skills.packResultTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("skills.packResultDesc", {
                ok: packReport?.succeeded ?? 0,
                failed: packReport?.failed ?? 0,
                warned: packReport?.warned ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex max-h-[55vh] flex-col gap-2 overflow-y-auto">
            <div className="rounded-lg border border-border bg-bg-subtle px-3 py-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-ink-3">{t("skills.packOutDir")}</div>
              <div className="mt-0.5 break-all font-mono text-[11px] text-ink-2" dir="ltr">
                {packReport?.outDir}
              </div>
              <div className="mt-1.5 text-[10px] font-medium uppercase tracking-wider text-ink-3">{t("skills.packIndexFile")}</div>
              <div className="mt-0.5 break-all font-mono text-[11px] text-ink-2" dir="ltr">
                {packReport?.indexPath}
              </div>
            </div>

            {packReport?.outcomes.map((o) => (
              <div key={o.dirName} className="rounded-lg border border-border bg-card px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  {o.ok ? <Check className="size-3.5 shrink-0 text-success" /> : <CircleAlert className="size-3.5 shrink-0 text-danger" />}
                  <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground">
                    {o.name || o.dirName}
                  </span>
                  {o.version ? <Badge variant="info">v{o.version}</Badge> : null}
                  {o.ok && o.warnings.length ? <Badge variant="warning">{t("skills.packWarnN", { n: o.warnings.length })}</Badge> : null}
                  {!o.ok ? <Badge variant="danger">{t("skills.packFailedTag")}</Badge> : null}
                </div>
                {!o.ok && o.error ? <p className="mt-1 text-[11px] leading-relaxed text-danger">{o.error}</p> : null}
                {o.ok && o.warnings.length ? (
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {o.warnings.map((w, i) => (
                      <li key={i} className="text-[11px] leading-relaxed text-warning">
                        · {w}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                if (packReport) void api.revealPath(packReport.outDir);
              }}
            >
              <FolderOpen />
              {t("skills.packOpenDir")}
            </Button>
            <Button onClick={() => setPackReport(null)}>{t("common.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 批量删除确认 ── */}
      <ConfirmDialog
        open={batchDeleteOpen}
        onOpenChange={setBatchDeleteOpen}
        title={t("skills.batchDeleteTitle")}
        message={t("skills.batchDeleteMsg", { n: batchSel.size })}
        danger
        onConfirm={() => {
          const names = [...batchSel];
          void (async () => {
            for (const dirName of names) await deleteSkill(dirName);
            toast.success(t("skills.batchDeleted", { n: names.length }));
            setBatchSel(new Set());
          })();
        }}
      />

            </div>
          </div>
        </>
      )}
   </PageShell>
  );
}
