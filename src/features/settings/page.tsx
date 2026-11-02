import { useState, useEffect } from "react";
import { DesktopFenceSettings, CollectSettings } from "@/features/files/desktop-settings";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FolderOpen, FolderInput, ExternalLink, Database, Palette, Info, Bot, Download, Upload, ListChecks, LayoutGrid } from "lucide-react";
import { Navigate, useSearchParams } from "react-router-dom";import { useModal } from "@/components/shell/modal-host";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/motion/button/base";
import { useSettings } from "@/stores/settings";
import { useAiSettings } from "@/stores/ai";
import { toggleThemeRadial, type ThemeMode, type VisualStyle } from "@/lib/theme";
import { changeLang, type Lang } from "@/lib/i18n";
import { flushAllStorage } from "@/lib/storage";
import { setDataDir as invokeSetDataDir, pickFolder, revealInExplorer } from "@/lib/tauri";
import { exportBackup, importBackup } from "@/features/settings/backup";
import { cn } from "@/lib/utils";
import { KnowledgeSettings } from "@/features/knowledge/settings";
import { ProviderSettings } from "@/features/ai/provider-settings";
import { FeedNetworkSettings } from "@/features/feeds/network-settings";
import { eosHealthSummary } from "@/search/eos";
import { useEosHealth } from "@/search/eos/health";
import { HomeFeedSection } from "./home-feed-section";
import { SearchSettings } from "@/features/search";
import { useAiDirty } from "./ai-dirty";

import { FeaturesSection } from "./features-section";
import { ShortcutsSettings } from "./shortcuts";

/**
 * 设置侧栏的落点：一个 section 一个独立路由（路由表见 `settings/layout.tsx`）。
 * 内容渲染在本文件，壳（侧栏、边距、返回）在 layout 里。
 */
export type SettingsSection =
  | "system"
  | "plans"
  | "ai-models"
  | "ai-knowledge"
  | "search"
  | "feeds"
  | "desktop"
  | "shortcuts"
  | "about";

/** 旧深链 `?tab=xxx` → 新路由。标题栏入口、通知、书签都还指向旧形状，不能断。 */
const TAB_ROUTES: Record<string, string> = {
  system: "/settings",
  plans: "/settings/plans",
  ai: "/settings/ai/models",
  knowledge: "/settings/ai/knowledge",
  search: "/settings/tools/search",
  feeds: "/settings/tools/feeds",
  features: "/settings",
  about: "/settings/about",
};

/** 设置页：独立路由 + 左侧功能分类侧栏 + 右侧内容 */
/**
 * 设置页的**内容**：按传入的 section 渲染对应区块。
 * 侧栏、页面边距、返回入口都由 `settings/layout.tsx` 提供 —— 这里只管内容，
 * 所以每个 section 都能是独立路由（/settings、/settings/plans、/settings/ai/models …）。
 */
export function SettingsPage({ section }: { section: SettingsSection }) {
  const [searchParams] = useSearchParams();
  // 旧深链 ?tab=xxx 仍在用（标题栏入口、通知、书签）：一律重定向到新路由
  const legacy = TAB_ROUTES[searchParams.get("tab") ?? ""];
  if (legacy) return <Navigate to={legacy} replace />;

  const wide = section === "ai-models";
  return (
    <div className={cn("mx-auto flex w-full flex-col gap-5", wide ? "max-w-6xl" : "max-w-2xl")}>
      {section === "system" && (
        <>
          <SystemSection />
          <DesktopDockCard />
          <FeaturesSection />
          <BackupCard />
        </>
      )}
      {section === "desktop" && (
        <>
          <DesktopFenceSettings />
          <CollectSettings />
        </>
      )}
      {section === "plans" && <PlansSection />}
      {section === "search" && <SearchSettings />}
      {section === "feeds" && (
        <>
          <HomeFeedSection />
          <FeedNetworkSettings />
        </>
      )}
      {section === "ai-models" && <AiSection />}
      {section === "ai-knowledge" && <KnowledgeSettings />}
      {section === "shortcuts" && <ShortcutsSettings />}
      {section === "about" && <AboutSection />}
    </div>
  );
}


/* ── 系统：外观 + 数据 ────────────────────────────────── */

function ResearchDirField() {
  const { t } = useTranslation();
  const researchRoot = useSettings((s) => s.researchRoot);
  const setResearchRoot = useSettings((s) => s.setResearchRoot);
  const [defaultDir, setDefaultDir] = useState("");
  useEffect(() => {
    void invoke<string>("research_default_dir").then(setDefaultDir).catch(() => undefined);
  }, []);
  const pick = async () => {
    try {
      const dir = await pickFolder();
      if (!dir) return;
      setResearchRoot(dir);
      toast.success(t("settings.researchRootSaved"));
    } catch (cause) {
      toast.error(String(cause));
    }
  };
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-[14px] font-medium">{t("settings.researchRoot")}</p>
          <p className="text-[12px] leading-5 text-muted-foreground">{t("settings.researchRootHint")}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" size="sm" onClick={() => void pick()}>
            <FolderInput className="size-4" />
            {t("settings.pickDir")}
          </Button>
          {researchRoot && (
            <Button variant="ghost" size="sm" onClick={() => setResearchRoot(null)}>
              {t("settings.researchRootReset")}
            </Button>
          )}
        </div>
      </div>
      <code className="truncate rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[12px] text-muted-foreground">
        {researchRoot || defaultDir || "…"}
      </code>
    </div>
  );
}

function SystemSection() {
  const { t } = useTranslation();
  const { confirm } = useModal();
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const visualStyle = useSettings((s) => s.visualStyle);
  const setVisualStyle = useSettings((s) => s.setVisualStyle);
  const lang = useSettings((s) => s.lang);
  const setLang = useSettings((s) => s.setLang);
  const dataDir = useSettings((s) => s.dataDir);
  const storeSetDataDir = useSettings((s) => s.setDataDir);
  const developerMode = useSettings((s) => s.developerMode);
  const setDeveloperMode = useSettings((s) => s.setDeveloperMode);
  const [migrating, setMigrating] = useState(false);

  /** 切换主题：径向扩散动画 */

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
      await flushAllStorage(); // 迁移前等待所有写入完成
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
      {/* 桌面栅格与收纳盒搬到「工具 › 桌面与收纳」，这里只留系统本身 */}
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

          <Field label={t("settings.visualStyle")}>
            <div className="flex flex-wrap gap-3">
              <StylePreview
                visual="pogget"
                selected={visualStyle === "pogget"}
                label={t("settings.stylePogget")}
                hint={t("settings.stylePoggetHint")}
                onClick={setVisualStyle}
              />
              <StylePreview
                visual="nimbus"
                selected={visualStyle === "nimbus"}
                label={t("settings.styleNimbus")}
                hint={t("settings.styleNimbusHint")}
                onClick={setVisualStyle}
              />
              <StylePreview
                visual="endfield"
                selected={visualStyle === "endfield"}
                label={t("settings.styleEndfield")}
                hint={t("settings.styleEndfieldHint")}
                onClick={setVisualStyle}
              />
            </div>
          </Field>

          {/* 快速面板快捷键已统一到「设置 › 快捷键」 */}

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
          <ResearchDirField />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-center justify-between gap-6">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="developer-mode" className="text-[14px] font-medium">{t("settings.developerMode")}</Label>
            <p id="developer-mode-hint" className="text-[13px] leading-relaxed text-muted-foreground">{t("settings.developerModeHint")}</p>
          </div>
          <Switch id="developer-mode" checked={developerMode} onCheckedChange={setDeveloperMode} aria-describedby="developer-mode-hint" />
        </CardContent>
      </Card>
      <DesktopDockCard />
      <BackupCard />
    </>
  );
}

/* ── 计划：提醒与完成行为 ───────────────────────────────── */

/* 桌面 Dock：总开关决定「有没有这个东西」（生命周期在 DesktopRuntime，Rust 侧门控），
   显示开关只决定「现在露不露面」；边向改动会重开窗口以应用。 */
function DesktopDockCard() {
  const { t } = useTranslation();
  const dockEnabled = useSettings((s) => s.dockEnabled);
  const dockOpen = useSettings((s) => s.dockOpen);
  const dockEdge = useSettings((s) => s.dockEdge);
  const dockAutoHide = useSettings((s) => s.dockAutoHide);
  const setDockEnabled = useSettings((s) => s.setDockEnabled);
  const setDockOpen = useSettings((s) => s.setDockOpen);
  const setDockEdge = useSettings((s) => s.setDockEdge);
  const dockStyle = useSettings((s) => s.dockStyle);
  const setDockStyle = useSettings((s) => s.setDockStyle);
  const dockCompactStyle = useSettings((s) => s.dockCompactStyle);
  const weatherCity = useSettings((s) => s.weatherCity);
  const weatherLat = useSettings((s) => s.weatherLat);
  const weatherLon = useSettings((s) => s.weatherLon);
  const setWeatherPlace = useSettings((s) => s.setWeatherPlace);
  const dockClickThrough = useSettings((s) => s.dockClickThrough);
  const setDockClickThrough = useSettings((s) => s.setDockClickThrough);
  const dockMonitorId = useSettings((s) => s.dockMonitorId);
  const setDockMonitorId = useSettings((s) => s.setDockMonitorId);
  const [monitors, setMonitors] = useState<{ name: string; primary: boolean }[]>([]);
  useEffect(() => {
    void import("@tauri-apps/api/window").then(({ availableMonitors }) => availableMonitors())
      .then((list) => setMonitors(list.map((m) => ({ name: m.name ?? "?", primary: m.position.x === 0 && m.position.y === 0 }))))
      .catch(() => setMonitors([]));
  }, []);
  const accentPreset = useSettings((s) => s.accentPreset);
  const setAccentPreset = useSettings((s) => s.setAccentPreset);
  const setDockCompactStyle = useSettings((s) => s.setDockCompactStyle);
  const setDockAutoHide = useSettings((s) => s.setDockAutoHide);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <LayoutGrid className="size-4 text-brand" />
          {t("settings.dock")}
        </CardTitle>
        <CardDescription>{t("settings.dockHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* 总开关：默认关。关掉时下面所有项都够不到 —— 不能让人以为调了有用 */}
        <label className="flex cursor-pointer items-start justify-between gap-3">
          <span className="flex flex-col gap-0.5">
            <span className="text-[13px] font-medium text-foreground/90">{t("settings.dockEnabled")}</span>
            <span className="text-[11px] leading-5 text-muted-foreground">{t("settings.dockEnabledHint")}</span>
          </span>
          <Switch checked={dockEnabled} onCheckedChange={setDockEnabled} aria-label={t("settings.dockEnabled")} />
        </label>
        {/*
         * 用 fieldset[disabled] 而不是逐个传 disabled：原生语义会把里面
         * 所有表单控件一起禁用（含 Radix 的 Switch/Button），鼠标点不动、
         * 键盘也进不去，少写一堆 props 又不会漏。
         */}
        <fieldset
          disabled={!dockEnabled}
          className="flex flex-col gap-4 border-0 p-0 transition-opacity disabled:opacity-45"
        >
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="text-[13px] font-medium text-foreground/90">{t("settings.dockEnable")}</span>
            <Switch checked={dockOpen} onCheckedChange={setDockOpen} aria-label={t("settings.dockEnable")} />
          </label>
          <Field label={t("settings.dockEdge")}>
            <div className="flex gap-2">
              {(["left", "right", "top"] as const).map((side) => (
                <Button key={side} variant={dockEdge === side ? "primary" : "secondary"} size="sm"
                  aria-pressed={dockEdge === side}
                  onClick={() => { setDockEdge(side); if (dockEnabled && dockOpen) invoke("dock_close").then(() => invoke("dock_open")).catch((error) => toast.error(String(error))); }}>
                  {t(`settings.dockEdge${side[0]!.toUpperCase()}${side.slice(1)}`)}
                </Button>
              ))}
            </div>
          </Field>
          <p className="text-[11px] leading-5 text-muted-foreground">{t("settings.dockEdgeHint")}</p>
          <Field label={t("settings.dockStyle")}>
            <div className="flex gap-2">
              {(["rail", "capsule"] as const).map((style) => (
                <Button key={style} variant={dockStyle === style ? "primary" : "secondary"} size="sm"
                  aria-pressed={dockStyle === style}
                  onClick={() => { setDockStyle(style); if (dockEnabled && dockOpen) invoke("dock_close").then(() => invoke("dock_open")).catch((error) => toast.error(String(error))); }}>
                  {t(style === "rail" ? "settings.dockStyleRail" : "settings.dockStyleCapsule")}
                </Button>
              ))}
            </div>
          </Field>
        <Field label={t("settings.compactStyle")}>
          <div className="flex gap-2">
            {(["capsule", "line"] as const).map((style) => (
              <Button key={style} variant={dockCompactStyle === style ? "secondary" : "ghost"}
                className={dockCompactStyle === style ? "ring-1 ring-brand" : undefined}
                onClick={() => setDockCompactStyle(style)}>
                {t(`settings.compactStyle_${style}`)}
              </Button>
            ))}
          </div>
        </Field>
        <Field label={t("settings.dockMonitor")}>
          <div className="flex flex-wrap gap-2">
            <Button variant={dockMonitorId === null ? "secondary" : "ghost"}
              className={dockMonitorId === null ? "ring-1 ring-brand" : undefined}
              onClick={() => setDockMonitorId(null)}>
              {t("settings.dockMonitor_follow")}
            </Button>
            {monitors.map((m) => (
              <Button key={m.name} variant={dockMonitorId === m.name ? "secondary" : "ghost"}
                className={dockMonitorId === m.name ? "ring-1 ring-brand" : undefined}
                onClick={() => setDockMonitorId(m.name)}>
                {m.name}{m.primary ? " (主屏)" : ""}
              </Button>
            ))}
          </div>
        </Field>
        <Field label={t("settings.clickThrough")}>
          <div>
            <Button variant={dockClickThrough ? "secondary" : "ghost"}
              className={dockClickThrough ? "ring-1 ring-brand" : undefined}
              onClick={() => setDockClickThrough(!dockClickThrough)}>
              {dockClickThrough ? t("settings.clickThroughOn") : t("settings.clickThroughOff")}
            </Button>
          </div>
        </Field>
        <Field label={t("settings.weatherPlace")}>
          <div className="flex flex-wrap items-center gap-2">
            <input className="h-8 w-32 rounded-md border border-border bg-background px-2 text-sm" value={weatherCity}
              onChange={(e) => setWeatherPlace(e.target.value, weatherLat, weatherLon)} />
            <input className="h-8 w-24 rounded-md border border-border bg-background px-2 text-sm" type="number" step="0.01" value={weatherLat}
              onChange={(e) => setWeatherPlace(weatherCity, Number(e.target.value), weatherLon)} />
            <input className="h-8 w-24 rounded-md border border-border bg-background px-2 text-sm" type="number" step="0.01" value={weatherLon}
              onChange={(e) => setWeatherPlace(weatherCity, weatherLat, Number(e.target.value))} />
          </div>
        </Field>
        <Field label={t("settings.accentPreset")}>
          <div className="flex flex-wrap gap-2">
            {(["sky", "ocean", "graphite", "warm"] as const).map((preset) => (
              <Button key={preset} variant={accentPreset === preset ? "secondary" : "ghost"}
                className={accentPreset === preset ? "ring-1 ring-brand" : undefined}
                onClick={() => setAccentPreset(preset)}>
                {t(`settings.accent_${preset}`)}
              </Button>
            ))}
          </div>
        </Field>
                  <p className="text-[11px] leading-5 text-muted-foreground">{t("settings.dockStyleHint")}</p>
          {/* Dock 快捷键已统一到「设置 › 快捷键」 */}
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="text-[13px] font-medium text-foreground/90">{t("settings.dockAutoHide")}</span>
            <Switch checked={dockAutoHide} onCheckedChange={setDockAutoHide} aria-label={t("settings.dockAutoHide")} />
          </label>
          <p className="text-[11px] leading-5 text-muted-foreground">{t("settings.dockAutoHideHint")}</p>
        </fieldset>
      </CardContent>
    </Card>
  );
}

function PlansSection() {
  return <CompletionCard />;
}

/*
 * 两个开关刻意不对称：
 *   置底 = 纯显示、随时可逆 → 默认开
 *   移除 = 真删数据          → 默认关
 * 默认值只在「用户不会因此丢东西」时才替用户决定。
 */
function CompletionCard() {
  const { t } = useTranslation();
  const autoSortDone = useSettings((s) => s.autoSortDone);
  const autoClearDone = useSettings((s) => s.autoClearDone);
  const setAutoSortDone = useSettings((s) => s.setAutoSortDone);
  const setAutoClearDone = useSettings((s) => s.setAutoClearDone);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <ListChecks className="size-4 text-brand" />
          {t("settings.completion")}
        </CardTitle>
        <CardDescription>{t("settings.completionHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span className="text-[13px] font-medium text-foreground/90">
            {t("plans.autoSortDone")}
          </span>
          <Switch checked={autoSortDone} onCheckedChange={setAutoSortDone} aria-label={t("plans.autoSortDone")} />
        </label>
        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span className="flex flex-col gap-0.5">
            <span className="text-[13px] font-medium text-foreground/90">
              {t("plans.autoClearDone")}
            </span>
            {/* 破坏性行为必须写明后果，否则用户勾了才发现东西没了 */}
            <span className="text-[11px] text-muted-foreground">
              {t("settings.completionClearHint")}
            </span>
          </span>
          <Switch
            checked={autoClearDone}
            onCheckedChange={setAutoClearDone}
            aria-label={t("plans.autoClearDone")}
          />
        </label>
      </CardContent>
    </Card>
  );
}

/* ── 系统：备份与恢复 ─────────────────────────────────── */

function BackupCard() {
  const { t } = useTranslation();
  const { confirm } = useModal();
  const [includeDirs, setIncludeDirs] = useState(true);
  const [overwriteSettings, setOverwriteSettings] = useState(false);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);

  const onExport = async () => {
    setBusy("export");
    try {
      const res = await exportBackup({ includeDirs });
      if (res) toast.success(t("settings.backupExported", { path: res.path }));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const onImport = async () => {
    const ok = await confirm({
      title: t("settings.backupConfirmTitle"),
      description: t("settings.backupConfirmDesc"),
      danger: false,
    });
    if (!ok) return;
    setBusy("import");
    try {
      const res = await importBackup({ overwriteSettings });
      if (res) {
        const { added, updated, skipped } = res.stats;
        toast.success(t("settings.backupDone", { added, updated, skipped }));
      }
    } catch (e) {
      // 解析失败给出明确原因（选错文件 vs 文件损坏）
      toast.error(`${t("settings.backupBadFile")}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <Database className="size-4 text-brand" />
          {t("settings.backup")}
        </CardTitle>
        <CardDescription>{t("settings.backupHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={includeDirs}
            onChange={(e) => setIncludeDirs(e.target.checked)}
            className="mt-0.5 size-4 accent-[var(--brand)]"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-[13px] font-medium text-foreground/90">
              {t("settings.backupIncludeFiles")}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {t("settings.backupIncludeFilesHint")}
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={overwriteSettings}
            onChange={(e) => setOverwriteSettings(e.target.checked)}
            className="mt-0.5 size-4 accent-[var(--brand)]"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-[13px] font-medium text-foreground/90">
              {t("settings.backupOverwriteSettings")}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {t("settings.backupOverwriteSettingsHint")}
            </span>
          </span>
        </label>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy !== null} onClick={() => void onExport()}>
            <Download className="size-4" />
            {busy === "export" ? t("settings.backupExporting") : t("settings.backupExport")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() => void onImport()}
          >
            <Upload className="size-4" />
            {busy === "import" ? t("settings.backupImporting") : t("settings.backupImport")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ── 奇妙搜索源状态：告诉用户这批规则现在有多少能用 ───────── */

function EosSourceStatus() {
  const { t } = useTranslation();
  // 订阅 store，规则健康度一变就重算（eosHealthSummary 读的是快照，不订阅就不会刷新）
  useEosHealth((s) => s.rules);
  const reset = useEosHealth((s) => s.reset);
  const summary = eosHealthSummary();

  return (
    <div className="rounded-md border border-input bg-muted/30 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
      <p>{t("feeds.eosHint", { usable: summary.usable, total: summary.total })}</p>
      {summary.cooling > 0 ? (
        <button type="button" onClick={reset} className="mt-1 underline underline-offset-2 hover:text-foreground">
          {t("feeds.eosReset")}
        </button>
      ) : null}
    </div>
  );
}

function AiSection() {
  const { setDirty: onDirtyChange } = useAiDirty();
  const { t } = useTranslation();
  const ai = useAiSettings();
  const setAi = useAiSettings((s) => s.setAi);
  const [aiDraft, setAiDraft] = useState<null | {
    searchProvider: string;
    tavilyApiKey: string;
  }>(null);
  const [aiSaved, setAiSaved] = useState(false);
  const aiCurrent = aiDraft ?? {
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
    <><ProviderSettings onDirtyChange={onDirtyChange} /><Card className="workbench-ui">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <Bot className="size-4" />
          {t("feeds.searchServices")}
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
            <option value="eos">{t("feeds.eos")}</option>
          </select>
        </div>
        {aiCurrent.searchProvider === "eos" ? <EosSourceStatus /> : null}
        <div className="space-y-1.5">
          <Label className="text-xs">{t("feeds.tavilyKey")}</Label>
          <Input type="password" value={aiCurrent.tavilyApiKey} onChange={(e) => updateAi({ tavilyApiKey: e.target.value })} placeholder="tvly-…" />
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={saveAi}>{t("feeds.saveAi")}</Button>
          {aiSaved ? <span className="text-xs text-success">{t("feeds.aiSaved")}</span> : null}
        </div>
      </CardContent>
    </Card></>
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

function StylePreview({
  visual,
  selected,
  label,
  hint,
  onClick,
}: {
  visual: VisualStyle;
  selected: boolean;
  label: string;
  hint: string;
  onClick: (style: VisualStyle) => void;
}) {
  const pogget = visual === "pogget";
  const endfield = visual === "endfield";
  return (
    <button
      type="button"
      onClick={() => onClick(visual)}
      aria-pressed={selected}
      aria-label={`${label} — ${hint}`}
      className={cn(
        "group flex w-[168px] flex-col overflow-hidden rounded-xl border-2 text-left transition-colors duration-150",
        selected ? "border-brand" : "border-border hover:border-muted-foreground/40",
      )}
    >
      <span
        className="relative block h-[74px] w-full overflow-hidden"
        style={{
          background: pogget
            ? "linear-gradient(90deg, #f3f4f6 0 34%, #ffffff 34% 100%)"
            : endfield
              ? "linear-gradient(90deg, #ededea 0 34%, #f4f4f2 34% 100%)"
              : "radial-gradient(120% 140% at 20% 0%, #dbeafe 0%, #f8fafc 55%, #e2e8f0 100%)",
        }}
      >
        {/* 侧栏三条杠 / 玻璃层一块：只画轮廓，不复制真实页面 */}
        <span className="absolute top-3 left-2 flex flex-col gap-1">
          {pogget ? (
            <>
              <span className="h-1.5 w-9 rounded-full bg-[#d1d5db]" />
              <span className="h-3 w-8 rounded-[4px] border border-[#e5e7eb] bg-white shadow-[0_1px_1px_rgba(0,0,0,0.05)]" />
              <span className="h-1.5 w-7 rounded-full bg-[#e5e7eb]" />
              <span className="h-1.5 w-8 rounded-full bg-[#e5e7eb]" />
            </>
          ) : endfield ? (
            <>
              <span className="h-1.5 w-9 bg-[#161616]" />
              <span className="relative h-3 w-8 bg-[#e4e4e0]">
                <span className="absolute inset-y-0 left-0 w-[2px] bg-[#fffa00]" />
              </span>
              <span className="h-1 w-7 bg-[#c9c9c5]" />
              <span className="h-1 w-8 bg-[#c9c9c5]" />
            </>
          ) : (
            <>
              <span className="h-1.5 w-9 rounded-full bg-white/70" />
              <span className="h-3 w-8 rounded-[4px] bg-white/45" />
              <span className="h-1.5 w-7 rounded-full bg-white/40" />
              <span className="h-1.5 w-8 rounded-full bg-white/40" />
            </>
          )}
        </span>
        <span
          className={cn(
            "absolute top-3 right-2 h-10 w-[96px] rounded-lg border",
            pogget && "border-[#e5e7eb] bg-white shadow-[inset_0_-1.5px_0_rgba(0,0,0,0.06)]",
            endfield && "rounded-none border-[#d9d9d6] bg-white",
            !pogget && !endfield && "border-white/50 bg-white/35 shadow-lg backdrop-blur",
          )}
        >
          <span
            className={cn(
              "absolute top-2 left-2 h-1 w-10 rounded-full",
              pogget && "bg-[#d1d5db]",
              endfield && "rounded-none bg-[#161616]",
              !pogget && !endfield && "bg-white/60",
            )}
          />
          <span
            className={cn(
              "absolute top-4 left-2 h-1 w-14 rounded-full",
              pogget && "bg-[#e5e7eb]",
              endfield && "rounded-none bg-[#c9c9c5]",
              !pogget && !endfield && "bg-white/45",
            )}
          />
          <span
            className={cn("absolute right-2 bottom-2 size-3 rounded-[4px]", endfield && "rounded-none")}
            style={{ background: pogget ? "#5279fb" : endfield ? "#fffa00" : "#3f63e0" }}
          />
        </span>
      </span>
      <span className="flex flex-col gap-0.5 border-t border-border bg-card px-2.5 py-2">
        <span className="text-[12px] font-semibold text-foreground">{label}</span>
        <span className="text-[10.5px] leading-tight text-muted-foreground">{hint}</span>
      </span>
    </button>
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
      aria-pressed={selected}
      aria-label={label}
      className={cn(
        "relative h-16 w-28 overflow-hidden rounded-xl border-2 transition-colors duration-150",
        selected ? "border-brand" : "border-border hover:border-muted-foreground/40",
      )}
      /*
       * 缩略图要显示**目标**主题。var(--pr-gray-*) 只在 :root 定义、.dark
       * 从不覆盖，所以这些原料色是「主题无关」的常量 —— 可以安全地用来画
       * 两种缩略图，而且永远与 tokens.css 同步（不必在这里抄一份 hex）。
       */
      style={{
        background: mode === "light" ? "var(--pr-gray-50)" : "var(--pr-gray-950)",
      }}
    >
      <span
        className="absolute top-2 left-2 h-1.5 w-10 rounded-full"
        style={{
          background: mode === "light" ? "var(--pr-gray-150)" : "var(--pr-gray-750)",
        }}
      />
      <span
        className="absolute top-6 left-2 h-1.5 w-16 rounded-full"
        style={{
          background: mode === "light" ? "var(--pr-gray-200)" : "var(--pr-gray-850)",
        }}
      />
      <span
        className="absolute right-2 bottom-2 size-5 rounded-md"
        style={{ background: "var(--pr-brand-500)" }}
      />
      {/* Use the represented theme's text color in both previews. */}
      <span
        className="absolute bottom-1.5 left-2 text-[11px] font-semibold"
        style={{
          color: mode === "light" ? "var(--pr-gray-600)" : "var(--pr-gray-300)",
        }}
      >
        {label}
      </span>
    </button>
  );
}
