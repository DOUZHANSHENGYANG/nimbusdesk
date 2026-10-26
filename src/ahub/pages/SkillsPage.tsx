import { Archive, ArrowRight, Boxes, Check, ChevronDown, CircleAlert, Clock, CloudUpload, Columns2, Copy, Eye, FolderOpen, GitCompare, History, Layers, ListChecks, Loader2, Package, Pencil, Plus, RefreshCw, RotateCw, Save, ScanSearch, Settings2, ShieldAlert, ShieldCheck, Sparkles, Tag, Trash2, Wand2, Wrench, X, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { toast } from "sonner";
import { ConfirmDialog } from "@/ahub/components/ConfirmDialog";
import { DeleteSkillsDialog, type DeleteSkillTarget } from "@/ahub/components/DeleteSkillsDialog";
import { EmptyState } from "@/ahub/components/EmptyState";
import { matchTags, type TagMode } from "@/ahub/components/TagFilter";
import { TagShelf } from "@/ahub/components/TagShelf";
import { BatchTagDialog, TagPicker } from "@/ahub/components/TagPicker";
import { UpstreamCheckDialog, UpstreamCheckIcon, type UpstreamRow } from "@/ahub/components/UpstreamCheckDialog";
import { TagManagerView } from "@/ahub/components/TagManagerView";
import { SearchBar } from "@/ahub/components/SearchBar";
import { HarnessDialog } from "@/ahub/components/HarnessDialog";
import { SkillsConfigDialog } from "@/ahub/components/SkillsConfigDialog";
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
import { api, copyText } from "@/ahub/lib/api";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AddSkillDialog } from "@/ahub/components/AddSkillDialog";
import { PresetDialog } from "@/ahub/components/PresetDialog";
import { PresetManager } from "@/ahub/components/PresetManager";
import { PresetRail } from "@/ahub/components/PresetRail";
import { presetErrorText } from "@/ahub/lib/presetErrors";
import type { HarnessReport, Preset, SkillDoc, SkillMeta } from "@/ahub/lib/types";
import { appliedHarnesses } from "@/ahub/lib/skillHarness";
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

/**
 * 时间显示。空值表示「时间不可知」——后端会剔除 DOS 纪元哨兵值
 * （ZIP 无日期时的时间戳、1980-01-01），此时显示破折号而不是假日期。
 * 中文语境显示「2026年9月1日 13点21分」，其余语言用 YYYY-MM-DD HH:mm。
 */
function fmtTime(iso?: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n: number) => String(n).padStart(2, "0");
    if (i18n.language?.startsWith("zh")) {
      return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}点${p(d.getMinutes())}分`;
    }
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

/**
 * 卡片上的更新时间只到「日」：`2026/12/02`。完整时间仍在 title 里（fmtTime）。
 * 空值与异常值沿用 fmtTime 的约定（破折号 / 原样返回），不造假日。
 */
function fmtDay(iso?: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
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
  const [batchTagOpen, setBatchTagOpen] = useState(false);
  /** 刚导入的目录名：批量打标签优先作用在这批上，而不是当前勾选 */
  const [tagTargetDirs, setTagTargetDirs] = useState<string[] | null>(null);
  const [upstreamOpen, setUpstreamOpen] = useState(false);
  const [upstreamRows, setUpstreamRows] = useState<UpstreamRow[]>([]);
  const [upstreamBusy, setUpstreamBusy] = useState(false);
  const [upstreamUpdating, setUpstreamUpdating] = useState<Set<string>>(new Set());
  const [scanOpen, setScanOpen] = useState(false);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [harnessReports, setHarnessReports] = useState<HarnessReport[] | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<"create" | "file" | "git">("file");
  const [batchMode, setBatchMode] = useState(false);
  const [batchSel, setBatchSel] = useState<Set<string>>(new Set());
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
  const [extSaving, setExtSaving] = useState(false);
  const [extDeps, setExtDeps] = useState<{ name: string; semver: string; reason: string }[]>([]);
  const [extRuntime, setExtRuntime] = useState({ requires_scripts: "none", requires_network: "none", min_protocol: 1, config: "" });
  const [extUpstream, setExtUpstream] = useState({ watch: false, mode: "manual", remote: "" });
  // 批量导入向导（skills-import）
  // AI 摘要（skills-summary）：单技能生成中 / 批量生成中
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [batchSummaryBusy, setBatchSummaryBusy] = useState(false);
  /** 本次会话里生成失败过的技能：不再自动重试，右侧摘要区也收起 */
  const [summaryFailed, setSummaryFailed] = useState<string[]>([]);
  /** 版本时间轴弹框 */
  const [versionsOpen, setVersionsOpen] = useState(false);
  /** 是否接入了 AI —— 与后端生成摘要的前置条件一致（有默认提供商且启用） */
  const aiDefaultProviderId = useSettings((s) => s.info?.settings.aiDefaultProviderId);
  const aiProviders = useSettings((s) => s.info?.settings.aiProviders);
  const aiReady = Boolean(
    aiDefaultProviderId && (aiProviders ?? []).some((p) => p.id === aiDefaultProviderId && p.enabled),
  );
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

  // 选中预设后批量勾选的调整，直接写回这个预设，不用进管理面板重新勾一遍
  const saveChangesToPreset = async () => {
    if (!selectedPreset) return;
    const dirNames = skills.filter((s) => batchSel.has(s.dirName)).map((s) => s.dirName);
    try {
      await api.presetUpdate(selectedPreset.id, { skillDirNames: dirNames });
    } catch (e) {
      toast.error(presetErrorText(e, t));
      return;
    }
    toast.success(t("preset.savedChanges", { name: selectedPreset.name }));
    await loadPresets();
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
  /** 还有未处置的审查发现才需要「审查」页签 */
  const needsReview = (detail?.meta.vetPending ?? 0) > 0;
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

  /** 左栏预设：count 只算仍存在的成员，stale 单独标出 */
  const presetRailItems = useMemo(
    () =>
      presets.map((p) => {
        const present = p.skillDirNames.filter((d) => liveDirs.has(d)).length;
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          count: present,
          stale: p.skillDirNames.length - present,
        };
      }),
    [presets, liveDirs],
  );

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

  /** dirName → 已接入的工具列表（只用于删除时判断是否有工具副本） */
  const appliedMap = useMemo(() => {
    const map = new Map<string, HarnessReport[]>();
    for (const s of skills) map.set(s.dirName, appliedHarnesses(skillHarnesses, s));
    return map;
  }, [skills, skillHarnesses]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // 预设筛选：只保留成员目录名命中的技能（与其他筛选取交集）
    const presetDirs = selectedPreset ? new Set(selectedPreset.skillDirNames) : null;
    return skills.filter((s) => {
      if (presetDirs && !presetDirs.has(s.dirName)) return false;
      if (!matchTags(s.tags, activeTags, tagMode)) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.tags.some((tg) => tg.toLowerCase().includes(q));
    });
  }, [skills, query, activeTags, tagMode, selectedPreset]);

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
  const hasFilter = query.trim().length > 0 || activeTags.size > 0 || selectedPresetId !== null;

  const clearFilters = () => {
    setQuery("");
    setActiveTags(new Set());
    setSelectedPresetId(null);
  };


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
          rows.push({ dirName: meta.dirName, name: meta.name, status, remote: report.remote, mode: report.mode, note: report.note });
        } catch (e) {
          rows.push({ dirName: meta.dirName, name: meta.name, status: "error", remote: "", mode: "", note: String(e) });
        }
      }
      setUpstreamRows(rows);
      setUpstreamOpen(true);
    } finally {
      setUpstreamBusy(false);
    }
  };

  /**
   * 一键更新：同一个远端只 clone 一次；逐个同名技能覆盖。
   * 覆盖前 `import_skill_folder` 会自动把旧正文压成版本（后端逻辑），
   * 覆盖后再把 `[source.upstream]` 写回去，避免更新完反而显示「未跟踪上游」。
   */
  const updateUpstream = async (targets: UpstreamRow[]) => {
    const rows = targets.filter((row) => row.status === "changed" && row.remote);
    if (!rows.length) return;
    setUpstreamUpdating(new Set(rows.map((row) => row.dirName)));
    const groups = new Map<string, UpstreamRow[]>();
    for (const row of rows) {
      const list = groups.get(row.remote) ?? [];
      list.push(row);
      groups.set(row.remote, list);
    }
    const normalize = (value: string) =>
      value.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9\u4e00-\u9fa5-]/g, "");
    const baseName = (path: string) =>
      normalize(path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "");
    const mark = (dirName: string, patch: Partial<UpstreamRow>) =>
      setUpstreamRows((current) => current.map((row) => (row.dirName === dirName ? { ...row, ...patch } : row)));
    let ok = 0;
    let failed = 0;
    for (const [remote, group] of groups) {
      let fetched: Awaited<ReturnType<typeof api.gitFetchSkills>>;
      try {
        fetched = await api.gitFetchSkills(remote);
      } catch (e) {
        for (const row of group) {
          mark(row.dirName, { status: "error", note: String(e) });
          failed += 1;
        }
        continue;
      }
      try {
        for (const row of group) {
          const target = normalize(row.dirName);
          const wanted = normalize(row.name);
          const candidate =
            fetched.skills.find((skill) => baseName(skill.path) === target) ??
            fetched.skills.find((skill) => normalize(skill.name) === wanted) ??
            fetched.skills.find((skill) => baseName(skill.path) === wanted);
          if (!candidate) {
            mark(row.dirName, { status: "error", note: t("skills.upUpdateNoMatch") });
            failed += 1;
            continue;
          }
          try {
            await api.importSkillFolder(candidate.path, true);
            // 覆盖会把远端仓库里的 SKILL.toml 带进来，上游跟踪信息要写回去；
            // 随后 check_upstream 会把 remote_head 记成刚拉到的那一版。
            await api.updateSkillExt(row.dirName, {
              upstream: { watch: true, mode: row.mode || "git-scan", remote },
            });
            await api.checkUpstream(row.dirName);
            mark(row.dirName, { status: "current", note: t("skills.upUpdated") });
            ok += 1;
          } catch (e) {
            mark(row.dirName, { status: "error", note: String(e) });
            failed += 1;
          }
        }
      } finally {
        await api.cleanupGitTemp(fetched.tempDir).catch(() => undefined);
      }
    }
    setUpstreamUpdating(new Set());
    await loadSkills();
    if (ok) toast.success(t("skills.upUpdateDone", { n: ok }));
    if (failed) toast.warning(t("skills.upUpdateFailed", { n: failed }));
  };

  const deleteTargetsOf = (items: SkillMeta[]): DeleteSkillTarget[] =>
    items.map((skill) => ({
      dirName: skill.dirName,
      name: skill.name,
      harnesses: (appliedMap.get(skill.dirName) ?? []).map((report) => ({ id: report.id, name: report.name })),
    }));

  /** 按工具合并：同一个工具一次调用移除它下面所有同名副本。 */
  const removeHarnessCopies = async (targets: DeleteSkillTarget[]) => {
    const byHarness = new Map<string, string[]>();
    for (const target of targets) {
      for (const harness of target.harnesses) {
        const names = byHarness.get(harness.id) ?? [];
        names.push(target.dirName);
        byHarness.set(harness.id, names);
      }
    }
    let failed = 0;
    for (const [harness, names] of byHarness) {
      try {
        await api.removeFromHarness(harness, "skills", names);
      } catch {
        failed += 1;
      }
    }
    return failed;
  };

  const deleteOne = async (removeCopies: boolean) => {
    if (!deleting) return;
    const target = deleteTargetsOf([deleting])[0];
    const failed = removeCopies ? await removeHarnessCopies([target]) : 0;
    await deleteSkill(deleting.dirName);
    await loadHarnesses();
    if (failed) toast.warning(t("skills.deleteHarnessFailed", { n: failed }));
    else toast.success(t("skills.deleted"));
  };

  const deleteBatch = async (removeCopies: boolean) => {
    const items = skills.filter((skill) => batchSel.has(skill.dirName));
    if (!items.length) return;
    const targets = deleteTargetsOf(items);
    const failedHarness = removeCopies ? await removeHarnessCopies(targets) : 0;
    let deleted = 0;
    let failed = 0;
    for (const skill of items) {
      try {
        await deleteSkill(skill.dirName);
        deleted += 1;
      } catch {
        failed += 1;
      }
    }
    await loadHarnesses();
    setBatchSel(new Set());
    if (failed) toast.warning(t("skills.batchDeletePartial", { ok: deleted, failed }));
    else toast.success(t("skills.batchDeleted", { n: deleted }));
    if (failedHarness) toast.warning(t("skills.deleteHarnessFailed", { n: failedHarness }));
  };

  /** 流水线单步：审查 = 体检（vet），摘要 = AI 批量，打包 = 导出 zip + index.json */
  /** 点击卡片上的标签：下钻筛选 */
  const drillTag = (tg: string) =>
    setActiveTags((prev) => {
      const n = new Set(prev);
      if (n.has(tg)) n.delete(tg);
      else n.add(tg);
      return n;
    });


  const toggleBatch = (dirName: string) =>
    setBatchSel((prev) => {
      const n = new Set(prev);
      if (n.has(dirName)) n.delete(dirName);
      else n.add(dirName);
      return n;
    });

  /** targetTab：点卡片上的版本号 / 待审核徽标时，直接落到对应页签（版本在 proto，审核在 review） */
  const openDetail = async (meta: SkillMeta, targetTab?: "proto" | "review") => {
    setDetailLoading(true);
    setDetail({
      meta,
      frontmatter: {},
      body: "",
      versions: [],
    });
    setTab(targetTab ?? "content");
    if (targetTab === "proto") void loadProto(meta.dirName);
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
      setSummaryFailed((prev) => prev.filter((x) => x !== dirName));
      setDetail((d) => (d && d.meta.dirName === dirName ? { ...d, meta: { ...d.meta, summary: s } } : d));
      await loadSkills();
      toast.success(t("skillSummary.done"));
    } catch (e) {
      // 失败时保留原有摘要不变（不动 detail）；记下这个技能，免得每次进卡片都重试、
      // 右侧还一直挂着一个空摘要区。
      setSummaryFailed((prev) => (prev.includes(dirName) ? prev : [...prev, dirName]));
      toast.error(t("skillSummary.failed", { error: summaryErrorText(String(e), t) }));
    } finally {
      setSummaryBusy(false);
    }
  };

  /**
   * 进卡片自动生成一次摘要。三个条件同时满足才生成：
   * 已接入 AI、这份技能还没有摘要、本次会话没失败过。
   * 已有摘要就不主动重生成（要重生成点工具栏那个按钮）。
   */
  useEffect(() => {
    if (!aiReady || !detail) return;
    const dirName = detail.meta.dirName;
    if (detail.meta.summary || summaryBusy) return;
    if (summaryFailed.includes(dirName)) return;
    void generateSummary(dirName);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只认「开了哪张卡片」；摘要写入后 dirName 不变，不会复发
  }, [aiReady, detail?.meta.dirName, summaryFailed]);

  /** 「审查」页签被藏起来时，停在它上面的要退回「内容」，否则 Tabs 指向不存在的页签 */
  useEffect(() => {
    if (tab === "review" && !needsReview) setTab("content");
  }, [tab, needsReview]);

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
   *   · true  —— 发布：落盘 + 以落盘后的内容记一条版本（后端 push_published 去重），
   *              并主动补一份 AI 摘要（没接入 AI 就没有这一步；已有摘要不重生成）
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
        publish,
        note: publish ? releaseNote.trim() : "",
      });
      if (publish) {
        setReleaseNote("");
        toast.success(t("skills.releaseSaved"));
      } else {
        toast.success(t("skills.saved"));
      }
      const dirName = detail.meta.dirName;
      const meta = skills.find((s) => s.dirName === dirName);
      // 先等详情读回来，再生成摘要 —— 否则摘要会被后到的详情覆盖
      if (meta) await openDetail(meta);
      if (publish && aiReady) await generateSummary(dirName);
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

  /**
   * 预览正文。frontmatter 不再拼回 Markdown —— 那样只会渲染成一坨 `key: value` 原文，
   * 改由 metaFields 一条一个表单项展示。
   */
  const composedPreview = (doc: SkillDoc) => doc.body;

  /** SKILL.md 的元信息（frontmatter）：键做 label，值只读展示。标签不是 frontmatter 字段，单独一行。 */
  const metaFields = (doc: SkillDoc) => {
    const rows = Object.entries(doc.frontmatter);
    return (
      <div className="mb-3 flex flex-col gap-2 border-b border-border pb-3">
        {rows.map(([key, value]) => (
          <Field key={key} label={key}>
            <Input
              readOnly
              value={typeof value === "string" ? value : JSON.stringify(value)}
              className="h-8 bg-bg-subtle font-mono text-[11px]"
            />
          </Field>
        ))}
        <Field label={t("common.tags")}>
          <div className="flex flex-wrap items-center gap-1">
            {editTags.length ? (
              editTags.map((tag) => (
                <Badge key={tag} variant="default">
                  {tag}
                </Badge>
              ))
            ) : (
              <span className="text-[11px] text-ink-3">—</span>
            )}
          </div>
        </Field>
      </div>
    );
  };

  return (
    <PageShell
      title={t("nav.skills")}
      actions={
        <>
          <SearchBar value={query} onChange={setQuery} placeholder={t("skills.searchPlaceholder")} className="w-56" />
          <AddSkillDialog onDone={() => void loadSkills()} onImported={openTagForImported} />
          <Button
            variant="secondary"
            onClick={() => {
              void loadHarnesses();
              setCfgOpen(true);
            }}
          >
            <Wrench />
            {t("skills.harnessCfg")}
          </Button>
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
        <TagManagerView allTags={allTags} counts={tagCounts} />
      ) : (
        <>
          <div className="flex min-h-0 flex-1 items-start gap-3">
            <aside className="flex w-[212px] shrink-0 flex-col gap-2">
              <PresetRail
                items={presetRailItems}
                selectedId={selectedPresetId}
                onSelect={setSelectedPresetId}
                onManage={() => {
                  void loadPresets();
                  setPresetManagerOpen(true);
                }}
                total={skills.length}
              />
              <TagShelf
                allTags={allTags}
                counts={tagCounts}
                hideWhenEmpty={false}
                selected={activeTags}
                onChange={setActiveTags}
                mode={tagMode}
                onModeChange={setTagMode}
                onManage={() => setPageTab("tags")}
              />
            </aside>
            <div className="min-w-0 flex-1">
      {/* ── 吸顶筛选台：来源工具 · 标签 · 视图 · 批量 ── */}
      {skills.length > 0 ? (
        <div
          data-anim
          className="ah-material sticky top-0 z-20 mb-4 rounded-xl border border-border px-3 py-2.5"
        >
          {/* 第一行：结果计数（视图只留网格，与 MCP 页一致，不再切换） */}
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
            </span>
          </div>

          {/* 第二行：动作区。常显两行 —— 不再用「批量选择」把按钮藏起来：
              按钮位置固定，不可用的动作是禁用，不是消失。 */}
          <div className="mt-2 flex flex-wrap items-start gap-2 border-t border-border/60 pt-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              {/* 第一行：内容操作四项 + AI 操作两项（竖线分开）；常显，没选中时禁用而不是消失 */}
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {/* 纳入技能管理：生成 SKILL.toml（已纳入自动跳过）+ 安全审查 */}
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 justify-center text-[11px]"
                  disabled={batchSel.size === 0 || onboardBusy}
                  onClick={() => void runOnboard()}
                >
                  {onboardBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
                  {t("skills.onboardBtn")}
                </Button>

                {/* 保存为预设：把当前选中的技能写成一个命名集合 */}
                {selectedPreset ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 justify-center text-[11px]"
                    disabled={batchSel.size === 0}
                    onClick={() => void saveChangesToPreset()}
                  >
                    <Save className="size-3.5" />
                    {t("preset.saveChanges")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 justify-center text-[11px]"
                  disabled={batchSel.size === 0}
                  onClick={() => setPresetSaveOpen(true)}
                >
                  <Layers className="size-3.5" />
                  {t("preset.saveAs")}
                </Button>

                {/* 打包导出：按 SSEP §7.1 生成规范 .skillpack，并写 index.json */}
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 justify-center text-[11px]"
                  disabled={batchSel.size === 0 || packExport}
                  onClick={() => void runPack()}
                >
                  {packExport ? <Loader2 className="size-3.5 animate-spin" /> : <Package className="size-3.5" />}
                  {t("skills.packExportBtn")}
                </Button>

                {/* 批量删除：唯一的破坏性动作，红色常显（二次确认后逐个删除） */}
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 justify-center border-danger/40 text-[11px] text-danger hover:bg-danger/10 hover:text-danger"
                  disabled={batchSel.size === 0}
                  onClick={() => setBatchDeleteOpen(true)}
                >
                  <Trash2 className="size-3.5" />
                  {t("skills.batchDelete")}
                </Button>

                <span className="h-5 w-px shrink-0 bg-border" aria-hidden />

                {/* 智能摘要：选中的技能逐个生成（未选中时禁用） */}
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 justify-center text-[11px]"
                  disabled={batchSel.size === 0 || batchSummaryBusy}
                  onClick={() => void runBatchSummary()}
                >
                  {batchSummaryBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                  {t("skills.batchSummaryBtn")}
                </Button>

                {/* 智能标签：批量追加 / 移除 / 清空 */}
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 justify-center text-[11px]"
                  disabled={batchSel.size === 0}
                  onClick={() => {
                    setTagTargetDirs(null);
                    setBatchTagOpen(true);
                  }}
                >
                  <Tag className="size-3.5" />
                  {t("skills.batchTagBtn")}
                </Button>
              </div>

              {/* 第二行：选择状态在左，进入 / 退出批量与全选所有在右 ——
                  右手侧操作更顺手，也离第一行的「批量删除」远一点，连点不会误伤。 */}
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="mr-auto shrink-0 tabular-nums text-[11px] text-ink-3">
                  {t("skills.batchSelectedShort", { n: batchSel.size })}
                </span>

                <Button
                  size="sm"
                  variant={batchMode ? "default" : "secondary"}
                  className="h-7 w-[104px] justify-center text-[11px]"
                  onClick={() => {
                    setBatchMode((prev) => !prev);
                    setBatchSel(new Set());
                  }}
                >
                  <ListChecks className="size-3.5" />
                  {batchMode ? t("skills.batchExit") : t("skills.batchEnter")}
                </Button>

                <span className="h-5 w-px shrink-0 bg-border" aria-hidden />

                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 w-[104px] justify-center text-[11px]"
                  disabled={skills.length === 0}
                  onClick={() =>
                    setBatchSel(
                      skills.length > 0 && skills.every((x) => batchSel.has(x.dirName))
                        ? new Set()
                        : new Set(skills.map((x) => x.dirName)),
                    )
                  }
                >
                  {skills.length > 0 && skills.every((x) => batchSel.has(x.dirName))
                    ? t("skills.batchUnselectAll")
                    : t("skills.batchSelectAll")}
                </Button>
              </div>
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
          // 生命周期状态的本地化显示（draft / active / deprecated / archived）
          const STATUS_LABEL: Record<string, string> = {
            draft: t("skills.statusDraft"),
            active: t("skills.statusActive"),
            deprecated: t("skills.statusDeprecated"),
            archived: t("skills.statusArchived"),
          };
          const card = (s: SkillMeta) => {
            const picked = batchSel.has(s.dirName);
            return (
              <div
                key={s.dirName}
                data-anim
                onClick={() => (batchMode ? toggleBatch(s.dirName) : void openDetail(s))}
                className={cn(
                  "group flex cursor-pointer flex-col gap-2 rounded-xl border border-border bg-card p-2.5 shadow-sm outline-none transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md",
                  picked && "border-primary shadow-[0_0_0_3px_var(--ah-primary-soft)]",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  {/* 选中标识只有一个：勾选框。只要「在批量模式」或「已经有选中」就整排显示出来
                      （不再出现「用全选所有选中的卡片只有边框、进批量模式才有勾选框」这种两套标识）。
                      卡片边框高亮只是同一状态的加强，永远和勾选框同时出现。 */}
                  {batchMode || batchSel.size > 0 ? (
                    <button
                      type="button"
                      aria-pressed={picked}
                      aria-label={t("common.selectCard", { name: s.name })}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleBatch(s.dirName);
                      }}
                      className={cn(
                        "mt-0.5 grid size-5 shrink-0 place-items-center rounded border transition-colors",
                        picked ? "border-primary bg-primary text-white" : "border-border-strong hover:border-primary/60",
                      )}
                    >
                      {picked ? <Check className="size-3.5" strokeWidth={3} /> : null}
                    </button>
                  ) : null}
                  <h3 className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-semibold text-foreground">{s.name}</h3>
                </div>
                {/* 状态行：版本号 · 审核状态 · 生命周期；行距由卡片根部的 gap 给 */}
                <div className="flex flex-wrap items-center gap-1">
                  {/* 协议状态：未纳入管理时显式标出，方便批量挑出来处理；点版本号直达版本时间轴 */}
                  {s.hasToml ? (
                    s.version !== "0.0.0" ? (
                      <Badge
                        variant="muted"
                        title={batchMode ? t("skills.protoVersionHint") : t("skills.gotoVersionsHint")}
                        onClick={(e) => {
                          if (batchMode) return;
                          e.stopPropagation();
                          void openDetail(s, "proto");
                        }}
                        className={batchMode ? undefined : "cursor-pointer hover:ring-1 hover:ring-info/40"}
                      >
                        v{s.version}
                      </Badge>
                    ) : null
                  ) : (
                    <Badge variant="warning" title={t("skills.noProtoHint")}>
                      <CircleAlert />
                      {t("skills.noProto")}
                    </Badge>
                  )}
                  {s.hasToml && s.status !== "active" ? (
                    <Badge variant="warning" title={t("skills.statusHint")}>
                      {STATUS_LABEL[s.status] ?? s.status}
                    </Badge>
                  ) : null}
                  {/* 安全审查：有待处置的发现就黄标（点它直达审查页签），全处置完绿标，机器结论 REJECT 红标 */}
                  {s.vetPending > 0 ? (
                    <Badge
                      variant="warning"
                      title={batchMode ? t("skills.reviewPendingHint") : t("skills.gotoReviewHint")}
                      onClick={(e) => {
                        if (batchMode) return;
                        e.stopPropagation();
                        void openDetail(s, "review");
                      }}
                      className={batchMode ? undefined : "cursor-pointer hover:ring-1 hover:ring-warning/40"}
                    >
                      <ShieldAlert />
                      {t("skills.reviewBadge")}
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
                </div>

                {/* 标签行 */}
                {s.tags.length ? (
                  <div className="flex flex-wrap items-center gap-1">
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
                          {/* 标签统一蓝色（和 MCP 页一致）；「正在筛选」用一圈 ring 表示 ——
                              蓝色是标签的专属色，状态徽标不许用它 */}
                          <Badge variant="default" className={cn("transition-shadow", on && "ring-1 ring-primary/60")}>
                            {tg}
                          </Badge>
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                {/* 底部行：更新时间 + 动作（复制路径 / 打开目录 / 删除） */}
                <div className="mt-auto flex items-center gap-1 border-t border-border/60 pt-2.5">
                  <span className="min-w-0 flex-1 truncate text-[11px] text-ink-3" title={fmtTime(s.updatedAt)}>
                    {fmtDay(s.updatedAt)}
                  </span>
                  {batchMode ? null : (
                    <span className="flex shrink-0 items-center gap-0.5">
                      <Button
                        size="iconSm"
                        variant="ghost"
                        className="text-ink-3/70 transition-colors hover:text-foreground"
                        title={t("common.copyPath")}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (dataDirs) {
                            void copyText(`${dataDirs.skills}\\${s.dirName}`).then((ok) => ok && toast.success(t("common.copied")));
                          }
                        }}
                      >
                        <Copy />
                      </Button>
                      <Button
                        size="iconSm"
                        variant="ghost"
                        className="text-ink-3/70 transition-colors hover:text-foreground"
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
                        className="text-ink-3/70 transition-colors hover:bg-danger/10 hover:text-danger"
                        title={t("common.delete")}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleting(s);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </span>
                  )}
                </div>
              </div>
            );
          };

          return <div className="grid grid-cols-3 gap-2">{filtered.map(card)}</div>;
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
                  {/* 目录写全路径，点一下直接复制 —— 不用先去资源管理器找 */}
                  <button
                    type="button"
                    title={t("common.copyPath")}
                    onClick={() => {
                      if (!dataDirs) return;
                      void copyText(`${dataDirs.skills}\\${detail.meta.dirName}`).then(
                        (ok) => ok && toast.success(t("common.copied")),
                      );
                    }}
                    className="inline-flex max-w-full items-center gap-1.5 align-middle outline-none hover:text-foreground"
                  >
                    <Copy className="size-3 shrink-0" />
                    <span className="truncate">
                      {dataDirs ? `${dataDirs.skills}\\${detail.meta.dirName}` : detail.meta.dirName}
                    </span>
                  </button>
                  <span> · {t("skills.charCount", { n: detail.meta.contentLen })}</span>
                </DialogDescription>
              </DialogHeader>

              <div className="border-b border-border px-5 pt-3">
                <Tabs value={tab} onValueChange={handleTab} variant="segment">
                  <TabsList>
                    <TabsTrigger value="content">{t("skills.tabContent")}</TabsTrigger>
                    <TabsTrigger value="files">{t("skills.tabFiles")}</TabsTrigger>
                    <TabsTrigger value="proto">{t("skills.protoTab")}</TabsTrigger>
                    {/* 审查页签按需出现：只有还剩未处置的发现时才需要它 */}
                    {needsReview ? (
                      <TabsTrigger value="review">
                        {t("skills.tabReview")}
                        <span className="ml-1.5 rounded-full bg-warning/15 px-1.5 py-px text-[10px] font-medium tabular-nums text-warning">
                          {detail.meta.vetPending}
                        </span>
                      </TabsTrigger>
                    ) : null}
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
                              {/* AI 摘要：不改内容、只补一份描述，所以和「暂存 / 发布」用竖线分开 */}
                              {aiReady ? (
                                <>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="secondary"
                                    disabled={summaryBusy || busy}
                                    onClick={() => void generateSummary(detail.meta.dirName)}
                                  >
                                    {summaryBusy ? (
                                      <Loader2 className="size-3.5 animate-spin" />
                                    ) : (
                                      <Wand2 className="size-3.5" />
                                    )}
                                    {summaryBusy
                                      ? t("skillSummary.generating")
                                      : detail.meta.summary
                                        ? t("skillSummary.regenerate")
                                        : t("skillSummary.generate")}
                                  </Button>
                                  <span className="h-5 w-px bg-border" aria-hidden />
                                </>
                              ) : null}
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
                              {/* 版本时间轴收进弹框：主界面只留这个入口 */}
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => setVersionsOpen(true)}
                              >
                                <History className="size-3.5" />
                                {t("skills.viewVersions")}
                              </Button>
                            </div>
                          </div>
                          {contentMode === "preview" ? (
                            <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-bg-subtle p-4">
                              {metaFields(detail)}
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
                                      <div className="mt-1.5">
                                        <Badge variant="outline">{t("skills.protoManaged")}</Badge>
                                      </div>
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
                              <div className="flex items-center justify-end gap-2">
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

                {/* 右栏只留 AI 摘要；版本时间轴收进「查看版本记录」弹框。
                    没接入 AI、或这个技能的摘要在本次会话生成失败过 —— 整栏不出现，正文拿满宽度。 */}
                {!detailLoading && aiReady && !summaryFailed.includes(detail?.meta.dirName ?? "") ? (
                  <aside className="flex w-[320px] shrink-0 flex-col gap-2">
                    {detail ? <SkillSummaryPanel summary={detail.meta.summary ?? null} /> : null}
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

      {/* 版本时间轴：主界面不再常驻展示，只在这个弹框里出现 */}
      <Dialog open={versionsOpen} onOpenChange={setVersionsOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="size-4 text-primary" />
              {t("skills.viewVersions")}
            </DialogTitle>
            <DialogDescription className="font-mono" dir="ltr">
              {detail?.meta.dirName}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="min-h-0">
            <div className="h-[58vh]">
              {detail ? (
                <VersionList
                  fill
                  versions={detail.versions}
                  current={editBody}
                  onSeed={() =>
                    void api
                      .seedSkillVersion(detail.meta.dirName, t("skills.seedVersionNote"))
                      .then((created) => {
                        toast[created ? "success" : "info"](t(created ? "skills.seedVersionDone" : "skills.seedVersionSkip"));
                        return api.readSkill(detail.meta.dirName);
                      })
                      .then((doc) => setDetail(doc))
                      .catch((e) => toast.error(String(e)))
                  }
                  onClear={() => setClearVerOpen(true)}
                  onRestore={(content) => {
                    // 版本快照是整份 SKILL.md；去掉 frontmatter 后填回正文
                    setEditBody(bodyOfDoc(content));
                    setTab("content");
                    setContentMode("edit");
                    setVersionsOpen(false);
                    toast.info(t("skills.versionRestored"));
                  }}
                />
              ) : null}
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <HarnessDialog open={scanOpen} onOpenChange={setScanOpen} kind="skills" />

      <SkillsConfigDialog
        open={cfgOpen}
        onOpenChange={setCfgOpen}
        reports={harnessReports}
        scanning={false}
        onRescan={() => void loadHarnesses()}
        skills={skills}
        onChanged={() => void loadSkills()}
      />

      <AddSkillDialog
        onDone={() => void loadSkills()}
        onImported={openTagForImported}
        open={addOpen}
        onOpenChange={setAddOpen}
        initialMode={addMode}
      />

      <UpstreamCheckDialog
        open={upstreamOpen}
        onOpenChange={setUpstreamOpen}
        rows={upstreamRows}
        updating={upstreamUpdating}
        onUpdate={(targets) => void updateUpstream(targets)}
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
        onItemsChanged={() => void loadSkills()}
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

      <DeleteSkillsDialog
        open={!!deleting}
        onOpenChange={(next) => !next && setDeleting(null)}
        title={t("skills.deleteConfirmTitle")}
        message={t("skills.deleteConfirmMsg", { name: deleting?.name ?? "" })}
        targets={deleting ? deleteTargetsOf([deleting]) : []}
        onConfirm={deleteOne}
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
      <DeleteSkillsDialog
        open={batchDeleteOpen}
        onOpenChange={setBatchDeleteOpen}
        title={t("skills.batchDeleteTitle")}
        message={t("skills.batchDeleteMsg", { n: batchSel.size })}
        targets={deleteTargetsOf(skills.filter((skill) => batchSel.has(skill.dirName)))}
        onConfirm={deleteBatch}
      />

            </div>
          </div>
        </>
      )}
   </PageShell>
  );
}
