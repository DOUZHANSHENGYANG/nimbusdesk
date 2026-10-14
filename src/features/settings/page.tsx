import { useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  FolderOpen,
  FolderInput,
  FolderTree,
  FolderX,
  ExternalLink,
  Database,
  Palette,
  Info,
  Bot,
  SlidersHorizontal,
  ArrowLeft,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useModal } from "@/components/shell/modal-host";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/motion/button/base";
import { useSettings } from "@/stores/settings";
import { useAiSettings } from "@/stores/ai";
import { toggleThemeRadial, type ThemeMode } from "@/lib/theme";
import { changeLang, type Lang } from "@/lib/i18n";
import { flushAllStorage } from "@/lib/storage";
import { setDataDir as invokeSetDataDir, pickFolder, revealInExplorer } from "@/lib/tauri";
import { gsap, useGSAP } from "@/lib/gsap";
import { cn } from "@/lib/utils";

type SettingsTab = "system" | "ai" | "about";

/** 设置页：独立路由 + 左侧分类侧栏（系统/AI/关于）+ 右侧内容 */
export function SettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [tab, setTab] = useState<SettingsTab>("system");
  const contentRef = useRef<HTMLDivElement>(null);

  const TABS: { key: SettingsTab; icon: React.ComponentType<{ className?: string }>; label: string }[] = [
    { key: "system", icon: SlidersHorizontal, label: t("settings.tabs.system") },
    { key: "ai", icon: Bot, label: t("settings.tabs.ai") },
    { key: "about", icon: Info, label: t("settings.tabs.about") },
  ];

  // 分类切换：内容淡入
  useGSAP(
    () => {
      gsap.fromTo(
        contentRef.current,
        { autoAlpha: 0, x: 10 },
        { autoAlpha: 1, x: 0, duration: 0.28, ease: "power2.out", clearProps: "all" },
      );
    },
    { dependencies: [tab], scope: contentRef },
  );

  return (
    <div className="flex h-full min-h-0">
      {/* ── 设置分类侧栏 ── */}
      <nav className="flex w-48 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        {/* 顶部返回（与标题栏 ⚙️ 入口同侧，符合操作动线） */}
        <div className="px-2.5 pt-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-[13px] font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
          >
            <ArrowLeft className="size-4" />
            {t("common.back")}
          </button>
        </div>

        <div className="px-4 pb-2 pt-3 text-[12px] font-semibold tracking-wide text-sidebar-foreground/60">
          {t("settings.title")}
        </div>
        <div className="flex flex-col gap-0.5 px-2.5">
          {TABS.map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                "flex h-9 items-center gap-2.5 rounded-lg px-3 text-[13px] font-medium transition-colors duration-150",
                tab === key
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
              )}
            >
              <Icon className={cn("size-4", tab === key && "text-brand")} />
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1" />
      </nav>

      {/* ── 内容区 ── */}
      <div ref={contentRef} className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-6 pb-10">
          {tab === "system" && <SystemSection />}
          {tab === "ai" && <AiSection />}
          {tab === "about" && <AboutSection />}
        </div>
      </div>
    </div>
  );
}

/* ── 系统：外观 + 数据 ────────────────────────────────── */

function SystemSection() {
  const { t } = useTranslation();
  const { confirm } = useModal();
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const lang = useSettings((s) => s.lang);
  const setLang = useSettings((s) => s.setLang);
  const dataDir = useSettings((s) => s.dataDir);
  const storeSetDataDir = useSettings((s) => s.setDataDir);
  const [migrating, setMigrating] = useState(false);

  const filesRoot = useSettings((s) => s.filesRoot);
  const setFilesRoot = useSettings((s) => s.setFilesRoot);

  /** 选择文件根目录：分类会自动在其中建同名子目录 */
  const chooseRoot = async () => {
    const picked = await pickFolder();
    if (!picked) return;
    setFilesRoot(picked);
    toast.success(t("files.rootBound", { dir: picked }));
  };

  const clearRoot = () => {
    setFilesRoot(null);
    toast.success(t("files.rootCleared"));
  };

  const onTheme = (mode: ThemeMode, e: React.MouseEvent) => {
    if (mode === theme) return;
    setTheme(mode);
    void toggleThemeRadial(mode, e.clientX, e.clientY);
  };

  const onLang = (l: Lang) => {
    if (l === lang) return;
    setLang(l);
    changeLang(l);
  };

  const confirmMigrate = (): Promise<boolean> =>
    confirm({
      title: t("settings.pickDir"),
      description: dataDir,
      danger: false,
    });

  const onPickDir = async () => {
    const dir = await pickFolder();
    if (!dir) return;
    if (dir === dataDir) return;
    const ok = await confirmMigrate();
    if (!ok) return;
    setMigrating(true);
    try {
      flushAllStorage(); // 迁移前落盘
      const result = await invokeSetDataDir(dir);
      storeSetDataDir(result.dataDir);
      toast.success(t("settings.migrated", { count: result.migrated.length }));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setMigrating(false);
    }
  };

  return (
    <>
      {/* 外观 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[15px]">
            <Palette className="size-4 text-brand" />
            {t("settings.appearance")}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <Field label={t("settings.theme")}>
            <div className="flex gap-3">
              <ThemePreview
                mode="light"
                selected={theme === "light"}
                label={t("settings.themeLight")}
                onClick={onTheme}
              />
              <ThemePreview
                mode="dark"
                selected={theme === "dark"}
                label={t("settings.themeDark")}
                onClick={onTheme}
              />
            </div>
          </Field>

          <Field label={t("settings.language")}>
            <div className="flex gap-2">
              {(["zh", "en"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => onLang(l)}
                  className={cn(
                    "h-9 rounded-full border px-4 text-[13px] font-medium transition-colors duration-150",
                    lang === l
                      ? "border-brand bg-brand/10 text-brand"
                      : "border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                  )}
                >
                  {l === "zh" ? t("settings.langZh") : t("settings.langEn")}
                </button>
              ))}
            </div>
          </Field>
        </CardContent>
      </Card>

      {/* 数据 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[15px]">
            <Database className="size-4 text-brand" />
            {t("settings.data")}
          </CardTitle>
          <CardDescription>{t("settings.dataDirHint")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
            <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
              {dataDir ?? "…"}
            </code>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={migrating} onClick={() => void onPickDir()}>
              <FolderInput className="size-4" />
              {migrating ? t("settings.migrating") : t("settings.pickDir")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => dataDir && void revealInExplorer(dataDir)}
            >
              <FolderOpen className="size-4" />
              {t("settings.openDir")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 文件根目录：所有分类的默认落盘位置 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[15px]">
            <FolderTree className="size-4 text-brand" />
            {t("settings.filesRoot")}
          </CardTitle>
          <CardDescription>{t("settings.filesRootHint")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
            <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
              {filesRoot ?? t("settings.filesRootUnset")}
            </code>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => void chooseRoot()}>
              <FolderInput className="size-4" />
              {filesRoot ? t("files.ctx.changeRoot") : t("files.ctx.setRoot")}
            </Button>
            {filesRoot && (
              <>
                <Button variant="ghost" size="sm" onClick={() => void revealInExplorer(filesRoot)}>
                  <FolderOpen className="size-4" />
                  {t("settings.openDir")}
                </Button>
                <Button variant="ghost" size="sm" onClick={clearRoot}>
                  <FolderX className="size-4" />
                  {t("settings.filesRootClear")}
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </>
  );
}

/* ── AI（资讯） ───────────────────────────────────────── */

function AiSection() {
  const { t } = useTranslation();
  const ai = useAiSettings();
  const setAi = useAiSettings((s) => s.setAi);
  const [aiDraft, setAiDraft] = useState<null | {
    llmBaseUrl: string;
    llmApiKey: string;
    llmModel: string;
    searchProvider: string;
    tavilyApiKey: string;
  }>(null);
  const [aiSaved, setAiSaved] = useState(false);
  const aiCurrent = aiDraft ?? {
    llmBaseUrl: ai.llmBaseUrl,
    llmApiKey: ai.llmApiKey,
    llmModel: ai.llmModel,
    searchProvider: ai.searchProvider || "auto",
    tavilyApiKey: ai.tavilyApiKey,
  };
  const updateAi = (patch: Partial<typeof aiCurrent>) => {
    setAiDraft({ ...aiCurrent, ...patch });
    setAiSaved(false);
  };
  const saveAi = () => {
    setAi(aiCurrent);
    setAiDraft(null);
    setAiSaved(true);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <Bot className="size-4" />
          {t("feeds.aiSection", "AI")}
        </CardTitle>
        <CardDescription>{t("feeds.aiDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="space-y-1.5">
          <Label className="text-xs">{t("feeds.searchBackend")}</Label>
          <select
            value={aiCurrent.searchProvider}
            onChange={(e) => updateAi({ searchProvider: e.target.value })}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
          >
            <option value="auto">{t("feeds.auto")}</option>
            <option value="bing">{t("feeds.bing")}</option>
            <option value="tavily">{t("feeds.tavily")}</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("feeds.llmEndpoint")}</Label>
          <Input value={aiCurrent.llmBaseUrl} onChange={(e) => updateAi({ llmBaseUrl: e.target.value })} placeholder="http://127.0.0.1:7865/v1" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("feeds.llmKey")}</Label>
          <Input type="password" value={aiCurrent.llmApiKey} onChange={(e) => updateAi({ llmApiKey: e.target.value })} placeholder="sk-…" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("feeds.llmModel")}</Label>
          <Input value={aiCurrent.llmModel} onChange={(e) => updateAi({ llmModel: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("feeds.tavilyKey")}</Label>
          <Input type="password" value={aiCurrent.tavilyApiKey} onChange={(e) => updateAi({ tavilyApiKey: e.target.value })} placeholder="tvly-…" />
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={saveAi}>{t("feeds.saveAi")}</Button>
          {aiSaved ? <span className="text-xs text-emerald-600">{t("feeds.aiSaved")}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}

/* ── 关于 ─────────────────────────────────────────────── */

function AboutSection() {
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <Info className="size-4 text-brand" />
          {t("settings.about")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-[13px] text-muted-foreground">
        <div className="flex items-center justify-between">
          <span>{t("settings.version")}</span>
          <span className="font-mono">0.1.0</span>
        </div>
        <div className="flex items-center justify-between">
          <span>{t("settings.stack")}</span>
          <span className="font-mono text-[12px]">Tauri 2 · React 19 · GSAP · beUI</span>
        </div>
        <button
          type="button"
          onClick={() =>
            void openUrl("https://github.com/BaldwinShu/FeatherFence").catch(() =>
              toast.error(t("common.error")),
            )
          }
          className="flex items-center justify-between text-left transition-colors hover:text-foreground"
        >
          <span>{t("settings.credit")}</span>
          <ExternalLink className="size-3.5 opacity-60" />
        </button>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-[13px] font-medium text-foreground/90">{label}</span>
      {children}
    </div>
  );
}

function ThemePreview({
  mode,
  selected,
  label,
  onClick,
}: {
  mode: ThemeMode;
  selected: boolean;
  label: string;
  onClick: (mode: ThemeMode, e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => onClick(mode, e)}
      className={cn(
        "relative h-16 w-28 overflow-hidden rounded-xl border-2 transition-colors duration-150",
        selected ? "border-brand" : "border-border hover:border-muted-foreground/40",
      )}
      style={{ background: mode === "light" ? "#f4f4f6" : "#141419" }}
    >
      <span
        className="absolute top-2 left-2 h-1.5 w-10 rounded-full"
        style={{ background: mode === "light" ? "#c9c9d1" : "#33333d" }}
      />
      <span
        className="absolute top-6 left-2 h-1.5 w-16 rounded-full"
        style={{ background: mode === "light" ? "#dcdce2" : "#23232b" }}
      />
      <span
        className="absolute right-2 bottom-2 size-5 rounded-md"
        style={{ background: "oklch(0.60 0.21 277)" }}
      />
      <span
        className={cn(
          "absolute bottom-1.5 left-2 text-[11px] font-semibold",
          mode === "light" ? "text-neutral-600" : "text-neutral-300",
        )}
      >
        {label}
      </span>
    </button>
  );
}
