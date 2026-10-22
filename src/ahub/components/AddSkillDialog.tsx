import {
  Check,
  Columns2,
  Download,
  Eye,
  FileArchive,
  FolderInput,
  GitCompare,
  Loader2,
  Pencil,
  Plus,
  ScanSearch,
  Search,
  Sparkles,
  Store,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Markdown } from "@/ahub/components/Markdown";
import { TagInput } from "@/ahub/components/TagInput";
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
import type { ImportPreview, MarketCategory, MarketSkill } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

/** 三种添加方式；`create` 默认选中（自己新建，零依赖） */
type Mode = "create" | "file" | "git";
/** Git 方式下的子来源：可克隆仓库 / 腾讯 SkillHub 市场 */
type GitSource = "repo" | "market";

interface Discovered {
  path: string;
  name: string;
  description: string;
}

/** 内置 git 源（可克隆的公开仓库） */
const PRESETS: { name: string; url: string }[] = [
  { name: "Anthropic 官方", url: "https://github.com/anthropics/skills" },
  { name: "MiniMax 官方", url: "https://github.com/MiniMax-AI/skills" },
  { name: "Superpowers", url: "https://github.com/obra/superpowers" },
];

const STARTER = "## 用途\n\n描述这个技能做什么、什么时候使用。\n\n## 用法\n\n1. 第一步\n2. 第二步\n";

const PAGE_SIZE = 24;

/**
 * 「添加技能」统一入口：三种方式合一。
 * - 自己新建（默认）：名称 / 描述 / 标签 + 正文编辑
 * - 从文件导入：文件夹（已解包）或 ZIP（压缩包）
 * - 从 Git 仓库 / 市场：克隆仓库自动发现，或从内置腾讯 SkillHub 搜索安装
 */
export function AddSkillDialog({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("create");
  const [gitSub, setGitSub] = useState<GitSource>("repo");
  const [busy, setBusy] = useState(false);
  const [overwrite, setOverwrite] = useState(false);

  // 新建
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newTags, setNewTags] = useState<string[]>([]);
  const [newBody, setNewBody] = useState(STARTER);
  const [newMode, setNewMode] = useState<"preview" | "edit" | "split">("edit");

  // 市场
  const [mq, setMq] = useState("");
  const [mCategory, setMCategory] = useState("all");
  const [mSource, setMSource] = useState("all");
  const [mSort, setMSort] = useState("score");
  const [mCats, setMCats] = useState<MarketCategory[]>([]);
  const [mSkills, setMSkills] = useState<MarketSkill[]>([]);
  const [mTotal, setMTotal] = useState(0);
  const [mPage, setMPage] = useState(1);
  const [mLoading, setMLoading] = useState(false);
  const [mErr, setMErr] = useState("");
  const [mSel, setMSel] = useState<Set<string>>(new Set());
  const [mReport, setMReport] = useState<{ ok: number; failed: { name: string; error: string }[] } | null>(null);

  // git
  const [gitUrl, setGitUrl] = useState("");
  const [discovered, setDiscovered] = useState<Discovered[] | null>(null);
  const [gitSel, setGitSel] = useState<Set<string>>(new Set());
  const [gitFilter, setGitFilter] = useState("");
  const [fetching, setFetching] = useState(false);
  const [gitTemp, setGitTemp] = useState("");
  /** 当前预览的候选目录路径（点击候选行时设置） */
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewErr, setPreviewErr] = useState("");

  const reset = () => {
    setMode("create");
    setGitSub("repo");
    setBusy(false);
    setNewName("");
    setNewDesc("");
    setNewTags([]);
    setNewBody(STARTER);
    setNewMode("edit");
    setMq("");
    setMCategory("all");
    setMSource("all");
    setMSort("score");
    setMSkills([]);
    setMTotal(0);
    setMPage(1);
    setMErr("");
    setMSel(new Set());
    setMReport(null);
    setGitUrl("");
    setDiscovered(null);
    setGitSel(new Set());
    setGitFilter("");
    setGitTemp("");
    setPreviewPath(null);
    setPreview(null);
    setPreviewErr("");
  };

  const close = () => {
    setOpen(false);
    reset();
  };

  // ── 市场 ──────────────────────────────────────────────
  const runSearch = async (page: number) => {
    setMLoading(true);
    setMErr("");
    try {
      const r = await api.skillhubSearch({
        keyword: mq,
        category: mCategory,
        source: mSource,
        sort: mSort,
        page,
        pageSize: PAGE_SIZE,
      });
      setMSkills(r.skills);
      setMTotal(r.total);
      setMPage(r.page);
    } catch (e) {
      setMErr(String(e));
      setMSkills([]);
      setMTotal(0);
    } finally {
      setMLoading(false);
    }
  };
  // 打开弹框 / 切到市场子来源时首次加载；筛选变化时回到第 1 页重查
  useEffect(() => {
    if (!open || mode !== "git" || gitSub !== "market") return;
    // 打开弹框 / 切换筛选时回到第 1 页重查（关键词用回车或按钮触发，避免每次击键都打接口）
    void runSearch(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, gitSub, mCategory, mSource, mSort]);

  useEffect(() => {
    if (!open || mode !== "git" || gitSub !== "market" || mCats.length) return;
    void api
      .skillhubCategories()
      .then(setMCats)
      .catch(() => undefined);
  }, [open, mode, gitSub, mCats.length]);

  const installSelected = async () => {
    const targets = mSkills
      .filter((s) => mSel.has(s.coordinate))
      .map((s) => ({ slug: s.slug, namespace: s.namespace, version: s.version, name: s.name }));
    if (!targets.length) return;
    setBusy(true);
    try {
      const reps = await api.skillhubInstall(targets, overwrite);
      const failed = reps.filter((r) => !r.ok).map((r) => ({ name: r.name || r.slug, error: r.error }));
      const ok = reps.length - failed.length;
      setMReport({ ok, failed });
      if (ok > 0) {
        toast.success(t("skills.marketInstalled", { ok, total: reps.length }));
        onDone();
      }
      if (failed.length && ok === 0) toast.error(failed[0].error);
      if (ok > 0 && failed.length === 0) close();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleSel = (coordinate: string) => {
    setMSel((prev) => {
      const next = new Set(prev);
      if (next.has(coordinate)) next.delete(coordinate);
      else next.add(coordinate);
      return next;
    });
  };

  const maxPage = Math.max(1, Math.ceil(mTotal / PAGE_SIZE));
  const mSelSkills = useMemo(() => mSkills.filter((s) => mSel.has(s.coordinate)), [mSkills, mSel]);

  // ── 新建 ──────────────────────────────────────────────
  const handleCreate = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      await api.saveSkill({
        dirName: "",
        name: newName.trim(),
        description: newDesc.trim(),
        tags: newTags,
        body: newBody,
        frontmatter: {},
      });
      toast.success(t("skills.saved"));
      onDone();
      close();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  // ── 从文件夹导入 ──────────────────────────────────────
  const importFolders = async () => {
    const picked = await openFileDialog({ directory: true, multiple: true, title: t("skills.folderPick") });
    if (!picked) return;
    const paths = (Array.isArray(picked) ? picked : [picked]).filter(Boolean) as string[];
    if (!paths.length) return;
    setBusy(true);
    let ok = 0;
    try {
      for (const p of paths) {
        try {
          const meta = await api.importSkillFolder(p, overwrite);
          ok += 1;
          toast.success(t("skills.imported", { name: meta.name }));
        } catch (e) {
          const msg = String(e);
          if (msg.includes("exists:")) toast.warning(t("skills.skippedExists", { name: p.split(/[\\/]/).pop() }));
          else toast.error(`${p.split(/[\\/]/).pop()}: ${msg}`);
        }
      }
      toast.info(t("skills.getDone", { ok, total: paths.length }));
      onDone();
      if (ok > 0) close();
    } finally {
      setBusy(false);
    }
  };

  // ── 从 ZIP 导入 ───────────────────────────────────────
  const importZip = async () => {
    const picked = await openFileDialog({
      directory: false,
      multiple: false,
      title: t("skills.zipPick"),
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (typeof picked !== "string" || !picked) return;
    setBusy(true);
    try {
      const meta = await api.importSkillZip(picked, overwrite);
      toast.success(t("skills.imported", { name: meta.name }));
      onDone();
      close();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  // ── git ───────────────────────────────────────────────
  const discover = async (url?: string) => {
    const target = (url ?? gitUrl).trim();
    if (!target) {
      toast.warning(t("skills.gitUrlPh"));
      return;
    }
    setGitUrl(target);
    setBusy(true);
    setFetching(true);
    setDiscovered(null);
    setGitSel(new Set());
    setGitFilter("");
    try {
      const r = await api.gitFetchSkills(target);
      setDiscovered(r.skills);
      setGitTemp(r.tempDir);
      if (!r.skills.length) toast.info(t("skills.gitNoSkills"));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setFetching(false);
      setBusy(false);
    }
  };

  const installDiscovered = async () => {
    if (!gitTemp || gitSel.size === 0) return;
    setBusy(true);
    let ok = 0;
    try {
      for (const path of gitSel) {
        try {
          await api.importSkillFolder(path, overwrite);
          ok += 1;
        } catch (e) {
          toast.error(`${path.split(/[\\/]/).pop()}: ${String(e)}`);
        }
      }
      toast.success(t("skills.getDone", { ok, total: gitSel.size }));
      onDone();
      if (ok > 0) close();
    } finally {
      setBusy(false);
    }
  };

  /** 点候选行 → 拉取该目录的预览。失败只提示，不影响选择。 */
  const loadPreview = async (path: string) => {
    setPreviewPath(path);
    setPreviewLoading(true);
    setPreviewErr("");
    try {
      setPreview(await api.previewSkillDir(path));
    } catch (e) {
      setPreview(null);
      setPreviewErr(String(e));
    } finally {
      setPreviewLoading(false);
    }
  };

  const filteredDiscovered = (discovered ?? []).filter((d) => {
    const q = gitFilter.trim().toLowerCase();
    if (!q) return true;
    return d.name.toLowerCase().includes(q) || (d.description ?? "").toLowerCase().includes(q);
  });

  const modes: { id: Mode; icon: typeof FolderInput; title: string; hint: string }[] = [
    { id: "create", icon: Sparkles, title: t("skills.modeCreate"), hint: t("skills.modeCreateHint") },
    { id: "file", icon: FolderInput, title: t("skills.modeFile"), hint: t("skills.modeFileHint") },
    { id: "git", icon: GitCompare, title: t("skills.modeGit"), hint: t("skills.modeGitHint") },
  ];

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        {t("skills.addSkill")}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) {
            if (gitTemp) void api.cleanupGitTemp(gitTemp).catch(() => undefined);
            close();
          }
        }}
      >
        <DialogContent wide className="h-[94vh] max-h-[94vh] sm:max-w-7xl">
          <DialogHeader>
            <DialogTitle>{t("skills.addTitle")}</DialogTitle>
            <DialogDescription>{t("skills.addHint")}</DialogDescription>
          </DialogHeader>

          <DialogBody className="flex min-h-0 flex-1 flex-col gap-4">
            {/* 方式选择 */}
            <div className="grid shrink-0 gap-2 sm:grid-cols-3">
              {modes.map(({ id, icon: Icon, title, hint }) => (
                <button
                  key={id}
                  type="button"
                  disabled={busy}
                  onClick={() => setMode(id)}
                  className={cn(
                    "flex flex-col gap-1 rounded-xl border p-3 text-left outline-none transition-all",
                    mode === id ? "border-primary shadow-[0_0_0_3px_var(--ah-primary-soft)]" : "border-border hover:border-border-strong",
                  )}
                >
                  <Icon className={cn("size-4", mode === id ? "text-primary" : "text-ink-3")} />
                  <span className="text-[13px] font-medium text-foreground">{title}</span>
                  <span className="text-[11px] leading-relaxed text-ink-3">{hint}</span>
                </button>
              ))}
            </div>

            {/* 覆盖开关（新建方式不需要） */}
            {mode !== "create" ? (
              <div className="flex shrink-0 items-center gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2">
                <Switch checked={overwrite} onCheckedChange={setOverwrite} />
                <span className="text-xs text-ink-2">{t("skills.overwriteSwitch")}</span>
              </div>
            ) : null}

            {/* Git 方式的子来源切换：可克隆仓库 / 腾讯 SkillHub 市场 */}
            {mode === "git" ? (
              <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5">
                {(
                  [
                    { id: "repo" as GitSource, icon: GitCompare, key: "skills.gitSubRepo" },
                    { id: "market" as GitSource, icon: Store, key: "skills.gitSubMarket" },
                  ] as const
                ).map(({ id, icon: Icon, key }) => (
                  <button
                    key={id}
                    type="button"
                    disabled={busy}
                    onClick={() => setGitSub(id)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium outline-none transition-colors",
                      gitSub === id ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
                    )}
                  >
                    <Icon className="size-3.5" />
                    {t(key)}
                  </button>
                ))}
              </div>
            ) : null}

            {/* ── 市场（Git 方式的子来源）：腾讯 SkillHub ── */}
            {mode === "git" && gitSub === "market" ? (
              <div className="flex min-h-0 flex-1 flex-col gap-3">
                {/* 搜索栏 */}
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <div className="relative min-w-52 flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" />
                    <Input
                      value={mq}
                      onChange={(e) => setMq(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void runSearch(1);
                      }}
                      placeholder={t("skills.marketSearchPh")}
                      className="h-9 pl-8"
                    />
                  </div>
                  <Select value={mCategory} onValueChange={setMCategory}>
                    <SelectTrigger className="h-9 w-36 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t("skills.marketAllCats")}</SelectItem>
                      {mCats.map((c) => (
                        <SelectItem key={c.key} value={c.key}>
                          {c.name || c.nameEn || c.key}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={mSource} onValueChange={setMSource}>
                    <SelectTrigger className="h-9 w-32 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t("skills.marketAllSources")}</SelectItem>
                      <SelectItem value="enterprise">{t("skills.marketSrcEnterprise")}</SelectItem>
                      <SelectItem value="community">{t("skills.marketSrcCommunity")}</SelectItem>
                      <SelectItem value="clawhub">{t("skills.marketSrcClawhub")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={mSort} onValueChange={setMSort}>
                    <SelectTrigger className="h-9 w-32 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="score">{t("skills.marketSortScore")}</SelectItem>
                      <SelectItem value="downloads">{t("skills.marketSortDownloads")}</SelectItem>
                      <SelectItem value="updated_at">{t("skills.marketSortUpdated")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button size="sm" className="h-9" onClick={() => void runSearch(1)} disabled={mLoading}>
                    {mLoading ? <Loader2 className="size-3.5 animate-spin" /> : <ScanSearch className="size-3.5" />}
                    {t("common.search")}
                  </Button>
                </div>

                {/* 结果统计 + 全选 */}
                <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11px] text-ink-3">
                  <span>
                    {t("skills.marketCount", { n: mTotal.toLocaleString(), page: mPage, max: maxPage })}
                  </span>
                  <span className="text-ink-3/50">·</span>
                  <button
                    type="button"
                    className="text-primary outline-none hover:underline disabled:opacity-40"
                    disabled={!mSkills.length}
                    onClick={() =>
                      setMSel((prev) =>
                        prev.size === mSkills.length && mSkills.length > 0
                          ? new Set()
                          : new Set(mSkills.map((s) => s.coordinate)),
                      )
                    }
                  >
                    {mSel.size === mSkills.length && mSkills.length > 0 ? t("mcp.unselectAll") : t("skills.marketSelectPage")}
                  </button>
                  {mSel.size > 0 ? (
                    <>
                      <span className="text-ink-3/50">·</span>
                      <button type="button" className="text-primary outline-none hover:underline" onClick={() => setMSel(new Set())}>
                        {t("skills.gitClearSel")}
                      </button>
                    </>
                  ) : null}
                </div>

                {/* 列表 */}
                <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border">
                  {mErr ? (
                    <div className="grid h-full place-items-center px-6 text-center text-xs text-danger">{mErr}</div>
                  ) : mLoading && !mSkills.length ? (
                    <div className="grid h-full place-items-center text-ink-3">
                      <Loader2 className="size-5 animate-spin" />
                    </div>
                  ) : !mSkills.length ? (
                    <div className="grid h-full place-items-center text-xs text-ink-3">{t("skills.marketEmpty")}</div>
                  ) : (
                    <div className="flex flex-col divide-y divide-border">
                      {mSkills.map((s) => {
                        const on = mSel.has(s.coordinate);
                        return (
                          <button
                            key={s.coordinate}
                            type="button"
                            onClick={() => toggleSel(s.coordinate)}
                            className={cn(
                              "flex items-start gap-3 px-3 py-2.5 text-left outline-none transition-colors",
                              on ? "bg-primary-soft" : "hover:bg-surface-2",
                            )}
                          >
                            <span
                              className={cn(
                                "mt-0.5 grid size-4 shrink-0 place-items-center rounded border",
                                on ? "border-primary bg-primary text-white" : "border-border-strong",
                              )}
                            >
                              {on ? <Check className="size-3" strokeWidth={3} /> : null}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-1.5">
                                <span className="truncate text-[13px] font-medium text-foreground">{s.name}</span>
                                {s.verified ? <Badge variant="info">{t("skills.marketVerified")}</Badge> : null}
                                {s.version ? <Badge variant="muted">v{s.version}</Badge> : null}
                                {s.source === "enterprise" ? <Badge variant="success">{t("skills.marketSrcEnterprise")}</Badge> : null}
                              </span>
                              {s.description ? (
                                <span className="mt-1 line-clamp-2 block text-[11px] leading-relaxed text-ink-2">{s.description}</span>
                              ) : null}
                              <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-ink-3">
                                <span className="font-mono" dir="ltr">
                                  {s.coordinate}
                                </span>
                                {s.publisher ? <span>{s.publisher}</span> : null}
                                <span>
                                  <Download className="mr-0.5 inline size-3" />
                                  {s.downloads.toLocaleString()}
                                </span>
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 安装结果 */}
                {mReport ? (
                  <div className="shrink-0 rounded-lg border border-border bg-bg-subtle px-3 py-2">
                    <div className="flex items-center gap-2 text-xs">
                      <Check className="size-3.5 shrink-0 text-success" />
                      <span className="text-ink-2">
                        {t("skills.marketInstalled", { ok: mReport.ok, total: mReport.ok + mReport.failed.length })}
                      </span>
                      <button type="button" className="ml-auto text-ink-3 outline-none hover:text-foreground" onClick={() => setMReport(null)}>
                        <X className="size-3.5" />
                      </button>
                    </div>
                    {mReport.failed.length ? (
                      <ul className="mt-1 flex flex-col gap-0.5">
                        {mReport.failed.map((f, i) => (
                          <li key={i} className="text-[11px] leading-relaxed text-danger">
                            · {f.name}：{f.error}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}

                {/* 分页 + 安装 */}
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8"
                    disabled={mPage <= 1 || mLoading}
                    onClick={() => void runSearch(mPage - 1)}
                  >
                    {t("skills.marketPrev")}
                  </Button>
                  <span className="text-[11px] tabular-nums text-ink-3">
                    {mPage} / {maxPage}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8"
                    disabled={mPage >= maxPage || mLoading}
                    onClick={() => void runSearch(mPage + 1)}
                  >
                    {t("skills.marketNext")}
                  </Button>

                  {/* ← 位置锚点：这个按钮必须始终是这一行的最后一个元素 */}
                  <Button className="ml-auto" onClick={() => void installSelected()} disabled={busy || mSel.size === 0}>
                    {busy ? <Loader2 className="animate-spin" /> : <Download />}
                    {t("skills.marketInstall", { n: mSel.size })}
                  </Button>
                </div>

                {mSelSkills.length ? (
                  <p className="shrink-0 truncate text-[10px] text-ink-3" dir="ltr">
                    {mSelSkills.map((s) => s.coordinate).join(" · ")}
                  </p>
                ) : null}
              </div>
            ) : null}

            {/* ── 方式一：自己新建（默认） ── */}
            {mode === "create" ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleCreate();
                }}
                className="flex min-h-0 flex-1 flex-col gap-4"
              >
                <div className="grid shrink-0 gap-4 sm:grid-cols-2">
                  <Field label={t("skills.fieldName")}>
                    <Input
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder={t("skills.namePlaceholder")}
                      autoFocus
                      className="font-mono"
                    />
                  </Field>
                  <Field label={t("common.tags")} hint={t("common.tagPlaceholder")}>
                    <TagInput value={newTags} onChange={setNewTags} />
                  </Field>
                </div>
                <Field label={t("common.description")} className="shrink-0">
                  <Textarea value={newDesc} onChange={(e) => setNewDesc(e.target.value)} className="min-h-16 resize-y" />
                </Field>
                <Field label={t("skills.fieldBody")} className="flex min-h-0 flex-1 flex-col">
                  <div className="mb-2 flex w-fit shrink-0 items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5">
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
                        onClick={() => setNewMode(m)}
                        className={cn(
                          "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium outline-none transition-colors",
                          newMode === m ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
                        )}
                      >
                        <Icon className="size-3.5" />
                        {t(key)}
                      </button>
                    ))}
                  </div>
                  {newMode === "preview" ? (
                    <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-bg-subtle p-4">
                      <Markdown source={newBody} />
                    </div>
                  ) : newMode === "edit" ? (
                    <Textarea
                      value={newBody}
                      onChange={(e) => setNewBody(e.target.value)}
                      spellCheck={false}
                      className="h-full min-h-0 flex-1 resize-none overflow-y-auto font-mono text-[13px]"
                    />
                  ) : (
                    <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
                      <Textarea
                        value={newBody}
                        onChange={(e) => setNewBody(e.target.value)}
                        spellCheck={false}
                        className="h-full resize-none overflow-y-auto font-mono text-[13px]"
                      />
                      <div className="overflow-y-auto rounded-lg border border-border bg-bg-subtle p-4">
                        <Markdown source={newBody} />
                      </div>
                    </div>
                  )}
                </Field>
                <div className="flex shrink-0 justify-end gap-2">
                  <Button type="button" variant="secondary" onClick={close} disabled={busy}>
                    {t("common.cancel")}
                  </Button>
                  <Button type="submit" disabled={busy || !newName.trim()}>
                    {busy ? <Loader2 className="animate-spin" /> : null}
                    {t("common.create")}
                  </Button>
                </div>
              </form>
            ) : null}

            {/* ── 方式二：从文件导入（文件夹 / ZIP） ── */}
            {mode === "file" ? (
              <div className="grid min-h-0 flex-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center gap-2">
                    <FolderInput className="size-4 shrink-0 text-primary" />
                    <span className="text-[13px] font-medium text-foreground">{t("skills.importFolderTitle")}</span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-ink-3">{t("skills.importFolderDesc")}</p>
                  <Button className="mt-auto w-full" onClick={() => void importFolders()} disabled={busy}>
                    {busy ? <Loader2 className="animate-spin" /> : <FolderInput />}
                    {t("skills.folderPickBtn")}
                  </Button>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center gap-2">
                    <FileArchive className="size-4 shrink-0 text-primary" />
                    <span className="text-[13px] font-medium text-foreground">{t("skills.importZipTitle")}</span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-ink-3">{t("skills.importZipDesc")}</p>
                  <Button className="mt-auto w-full" onClick={() => void importZip()} disabled={busy}>
                    {busy ? <Loader2 className="animate-spin" /> : <FileArchive />}
                    {t("skills.zipPickBtn")}
                  </Button>
                </div>
              </div>
            ) : null}

            {/* ── Git 方式的子来源：从 Git 仓库导入 ── */}
            {mode === "git" && gitSub === "repo" ? (
              <div className="flex min-h-0 flex-1 flex-col gap-3 rounded-xl border border-border bg-card p-4">
                <div>
                  <div className="mb-1.5 text-[11px] font-medium text-ink-3">{t("skills.gitPreset")}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {PRESETS.map((preset) => (
                      <button
                        key={preset.url}
                        type="button"
                        disabled={busy}
                        onClick={() => void discover(preset.url)}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-[11px] font-medium outline-none transition-colors",
                          gitUrl === preset.url
                            ? "border-primary bg-primary text-white"
                            : "border-border text-ink-2 hover:border-primary/40 hover:text-primary",
                        )}
                      >
                        {preset.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    value={gitUrl}
                    onChange={(e) => setGitUrl(e.target.value)}
                    placeholder={t("skills.gitUrlPh")}
                    className="h-8 font-mono text-xs"
                  />
                  <Button size="sm" onClick={() => void discover()} disabled={busy || !gitUrl.trim()}>
                    <ScanSearch className="size-3.5" />
                    {t("skills.discover")}
                  </Button>
                </div>
                <p className="text-[11px] leading-relaxed text-ink-3">{t("skills.gitHint")}</p>

                {fetching ? (
                  <div className="flex items-center justify-center gap-2 rounded-lg bg-bg-subtle px-3 py-6 text-ink-3">
                    <Loader2 className="size-4 animate-spin" />
                    <span className="text-xs">{t("skills.gitFetching")}</span>
                  </div>
                ) : discovered ? (
                  discovered.length ? (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="relative min-w-40 flex-1">
                          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" />
                          <Input
                            value={gitFilter}
                            onChange={(e) => setGitFilter(e.target.value)}
                            placeholder={t("skills.gitFilterPh")}
                            className="h-8 pl-8 text-xs"
                          />
                        </div>
                        <span className="shrink-0 text-[11px] text-ink-3">
                          {t("skills.gitSelCount", { n: gitSel.size, total: discovered.length })}
                        </span>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-8 text-[11px]"
                          onClick={() =>
                            setGitSel((prev) =>
                              prev.size === filteredDiscovered.length && filteredDiscovered.length > 0
                                ? new Set()
                                : new Set(filteredDiscovered.map((d) => d.path)),
                            )
                          }
                        >
                          {gitSel.size === filteredDiscovered.length && filteredDiscovered.length > 0
                            ? t("mcp.unselectAll")
                            : t("common.selectAll")}
                        </Button>
                        <Button size="sm" variant="secondary" className="h-8 text-[11px]" disabled={gitSel.size === 0} onClick={() => setGitSel(new Set())}>
                          {t("skills.gitClearSel")}
                        </Button>
                      </div>
                      {/* 左：候选列表 / 右：内容预览 —— 导入前先看清是什么 */}
                      <div className="flex min-h-0 flex-1 gap-3">
                      <div className="flex min-h-0 w-[300px] shrink-0 flex-col gap-1 overflow-y-auto pr-1">
                        {filteredDiscovered.map((d) => {
                          const checked = gitSel.has(d.path);
                          const active = previewPath === d.path;
                          return (
                            <button
                              key={d.path}
                              type="button"
                              onClick={() => {
                                // 单击预览，勾选框单独管选择
                                void loadPreview(d.path);
                              }}
                              onDoubleClick={() =>
                                setGitSel((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(d.path)) next.delete(d.path);
                                  else next.add(d.path);
                                  return next;
                                })
                              }
                              className={cn(
                                "flex items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left outline-none transition-colors",
                                active
                                  ? "border-primary bg-primary-soft"
                                  : checked
                                    ? "border-primary/40 bg-primary-soft/50"
                                    : "border-transparent hover:bg-surface-2",
                              )}
                            >
                              <span
                                role="checkbox"
                                aria-checked={checked}
                                tabIndex={0}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setGitSel((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(d.path)) next.delete(d.path);
                                    else next.add(d.path);
                                    return next;
                                  });
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === " " || e.key === "Enter") {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setGitSel((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(d.path)) next.delete(d.path);
                                      else next.add(d.path);
                                      return next;
                                    });
                                  }
                                }}
                                className={cn(
                                  "mt-0.5 grid size-4 shrink-0 cursor-pointer place-items-center rounded border",
                                  checked ? "border-primary bg-primary text-white" : "border-border-strong",
                                )}
                              >
                                {checked ? <Check className="size-3" strokeWidth={3} /> : null}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-mono text-xs font-medium text-foreground">{d.name}</span>
                                {d.description ? <span className="mt-0.5 block truncate text-[11px] text-ink-3">{d.description}</span> : null}
                              </span>
                            </button>
                          );
                        })}
                        {filteredDiscovered.length === 0 ? (
                          <p className="px-3 py-4 text-center text-[11px] text-ink-3">{t("skills.gitFilterEmpty")}</p>
                        ) : null}
                      </div>

                      {/* 右：预览 */}
                      <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-border bg-bg-subtle">
                        {previewLoading ? (
                          <div className="flex flex-1 items-center justify-center gap-2 text-[11px] text-ink-3">
                            <Loader2 className="size-3.5 animate-spin" />
                            {t("common.loading")}
                          </div>
                        ) : previewErr ? (
                          <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] text-danger">
                            {previewErr}
                          </div>
                        ) : !preview ? (
                          <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] text-ink-3">
                            {t("skills.previewHint")}
                          </div>
                        ) : (
                          <>
                            <div className="shrink-0 border-b border-border px-3 py-2">
                              <div className="flex items-center gap-2">
                                <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium text-foreground">
                                  {preview.name}
                                </span>
                                {preview.existsInHub ? (
                                  <Badge variant="warning">{t("skills.previewInHub")}</Badge>
                                ) : null}
                              </div>
                              {preview.description ? (
                                <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-ink-3">
                                  {preview.description}
                                </p>
                              ) : null}
                            </div>
                            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
                              {preview.body.trim() ? (
                                <Markdown source={preview.body} />
                              ) : (
                                <p className="text-[11px] text-ink-3">{t("skills.previewEmptyBody")}</p>
                              )}
                            </div>
                            <div className="shrink-0 border-t border-border px-3 py-1.5 text-[10px] text-ink-3">
                              {t("skills.previewFiles", { n: preview.files.length })}
                            </div>
                          </>
                        )}
                      </div>
                      </div>
                      <Button className="shrink-0" onClick={() => void installDiscovered()} disabled={busy || gitSel.size === 0}>
                        {busy ? <Loader2 className="animate-spin" /> : null}
                        {t("skills.installSel")}
                      </Button>
                    </>
                  ) : (
                    <p className="rounded-lg bg-bg-subtle px-3 py-2.5 text-xs text-ink-2">{t("skills.gitNoSkills")}</p>
                  )
                ) : null}
              </div>
            ) : null}
          </DialogBody>

          <DialogFooter>
            <Button variant="secondary" onClick={close} disabled={busy}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
