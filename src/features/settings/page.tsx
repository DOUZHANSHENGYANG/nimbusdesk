import { useRef, useState } from "react";
import { DesktopFenceSettings } from "@/features/files/desktop-settings";
import { useReminderSettings } from "@/stores/reminders";
import { advanceLabel } from "@/features/plans/reminder";
import {
  requestNotificationPermission,
  notificationPermission,
  sendNotification,
} from "@/lib/notify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FolderOpen, FolderInput, ExternalLink, Database, Palette, Info, Bot, SlidersHorizontal, ArrowLeft, Download, Upload, Bell, TriangleAlert, ListChecks, BookOpen, CalendarCheck, Search, LayoutGrid } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useModal } from "@/components/shell/modal-host";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/motion/button/base";
import { useSettings } from "@/stores/settings";
import { useAiSettings } from "@/stores/ai";
import { toggleThemeRadial, type ThemeMode } from "@/lib/theme";
import { changeLang, type Lang } from "@/lib/i18n";
import { flushAllStorage } from "@/lib/storage";
import { setDataDir as invokeSetDataDir, pickFolder, revealInExplorer } from "@/lib/tauri";
import { exportBackup, importBackup } from "@/features/settings/backup";
import { gsap, useGSAP } from "@/lib/gsap";
import { cn } from "@/lib/utils";
import { KnowledgeSettings } from "@/features/knowledge/settings";
import { ShortcutRecorder } from "@/features/knowledge/shortcut-recorder";
import { ProviderSettings } from "@/features/ai/provider-settings";
import { FeedNetworkSettings } from "@/features/feeds/network-settings";
import { useProviderCopy } from "@/features/ai/provider-copy";
import { SearchSettings } from "@/features/search";

import { FeaturesSection } from "./features-section";

type SettingsTab = "system" | "plans" | "knowledge" | "feeds" | "ai" | "features" | "about" | "search";

/** 设置页：独立路由 + 左侧功能分类侧栏 + 右侧内容 */
export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { confirm } = useModal();
  const aiCopy = useProviderCopy();
  const [aiDirty, setAiDirty] = useState(false);
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<SettingsTab>(searchParams.get("tab") === "search" ? "search" : searchParams.get("tab") === "ai" ? "ai" : searchParams.get("tab") === "knowledge" ? "knowledge" : "system");
  const contentRef = useRef<HTMLDivElement>(null);
  async function leaveAi() {
    if (tab !== "ai" || !aiDirty) return true;
    return confirm({ title: aiCopy.discardTitle, description: aiCopy.discardHint, confirmText: aiCopy.discard, cancelText: aiCopy.stay });
  }

  const TABS: { key: SettingsTab; icon: React.ComponentType<{ className?: string }>; label: string }[] = [
    { key: "system", icon: SlidersHorizontal, label: t("settings.tabs.system") },
    { key: "plans", icon: CalendarCheck, label: t("settings.tabs.plans") },
    { key: "search", icon: Search, label: i18n.language.startsWith("en") ? "Search" : "搜索" },
    { key: "knowledge", icon: BookOpen, label: t("nav.knowledge") },
    { key: "feeds", icon: SlidersHorizontal, label: t("nav.feeds") },
    { key: "ai", icon: Bot, label: t("settings.tabs.ai") },
    { key: "features", icon: LayoutGrid, label: t("settings.tabs.features") },
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
            onClick={() => { void leaveAi().then((allowed) => { if (allowed) navigate(-1); }); }}
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
              aria-current={tab === key ? "page" : undefined}
              onClick={() => { if (key !== tab) void leaveAi().then((allowed) => { if (allowed) { setAiDirty(false); setTab(key); } }); }}
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
        <div className={cn("mx-auto flex w-full flex-col gap-5 p-6 pb-10", tab === "ai" ? "max-w-6xl" : "max-w-2xl")}>
          {tab === "system" && <SystemSection />}
          {tab === "plans" && <PlansSection />}
          {tab === "search" && <SearchSettings />}
          {tab === "knowledge" && <KnowledgeSettings />}
          {tab === "feeds" && <FeedNetworkSettings />}
          {tab === "ai" && <AiSection onDirtyChange={setAiDirty} />}
          {tab === "features" && <FeaturesSection />}
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
      <DesktopFenceSettings />
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
  const en = useSettings((s) => s.lang) === "en";
  const dockEnabled = useSettings((s) => s.dockEnabled);
  const dockOpen = useSettings((s) => s.dockOpen);
  const dockEdge = useSettings((s) => s.dockEdge);
  const dockShortcut = useSettings((s) => s.dockShortcut);
  const dockAutoHide = useSettings((s) => s.dockAutoHide);
  const setDockEnabled = useSettings((s) => s.setDockEnabled);
  const setDockOpen = useSettings((s) => s.setDockOpen);
  const setDockEdge = useSettings((s) => s.setDockEdge);
  const setDockShortcut = useSettings((s) => s.setDockShortcut);
  const setDockAutoHide = useSettings((s) => s.setDockAutoHide);
  const [shortcutDraft, setShortcutDraft] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [shortcutError, setShortcutError] = useState("");

  const saveShortcut = async (value: string) => {
    setShortcutError("");
    try {
      await invoke("set_dock_shortcut", { shortcut: value.trim() });
      setDockShortcut(value.trim());
      setShortcutDraft(null);
      toast.success(en ? "Dock shortcut saved" : "Dock 快捷键已保存");
    } catch (cause) { setShortcutError(String(cause)); }
  };

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
          <Field label={t("settings.dockShortcut")}>
            <ShortcutRecorder placeholder="Ctrl+Alt+D" value={shortcutDraft ?? dockShortcut}
              onChange={(value) => { setShortcutDraft(value); setShortcutError(""); }} en={en}
              disabled={recording} onRecordingChange={setRecording} />
          </Field>
          {shortcutError && <p role="alert" className="text-xs leading-5 text-destructive">{shortcutError}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={recording || (shortcutDraft ?? dockShortcut) === dockShortcut}
              onClick={() => void saveShortcut(shortcutDraft ?? dockShortcut)}>
              {en ? "Save shortcut" : "保存快捷键"}
            </Button>
            {!!dockShortcut && <Button size="sm" variant="ghost" disabled={recording}
              onClick={() => void saveShortcut("")}>{en ? "Clear" : "清除"}</Button>}
          </div>
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
  return <><ReminderCard /><CompletionCard /></>;
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

function ReminderCard() {
  const { t } = useTranslation();
  const enabled = useReminderSettings((s) => s.enabled);
  const advance = useReminderSettings((s) => s.advance);
  const setEnabled = useReminderSettings((s) => s.setEnabled);
  const setAdvance = useReminderSettings((s) => s.setAdvance);
  const clearNotified = useReminderSettings((s) => s.clearNotified);
  const [denied, setDenied] = useState(false);

  /** 开启提醒时顺带申请系统通知权限；被拒就如实说明 */
  const onToggle = async () => {
    if (enabled) {
      setEnabled(false);
      return;
    }
    const state = await requestNotificationPermission();
    if (state === "denied") {
      setDenied(true);
      return;
    }
    setDenied(false);
    setEnabled(true);
  };

  const onTest = async () => {
    const ok = await sendNotification(t("settings.reminder"), t("settings.reminderTestSent"));
    if (ok) toast.success(t("settings.reminderTestSent"));
    else {
      const state = await notificationPermission();
      if (state === "denied") setDenied(true);
      toast.error(t("common.error"));
    }
  };

  /** 改设置后清空去重集合：否则「改成提前 30 分钟」不会让已通知过的任务再提醒 */
  const onAdvance = (v: number) => {
    setAdvance(v);
    clearNotified();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <Bell className="size-4 text-brand" />
          {t("settings.reminder")}
        </CardTitle>
        <CardDescription>{t("settings.reminderHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span className="text-[13px] font-medium text-foreground/90">
            {t("settings.reminderEnable")}
          </span>
          <Switch
            checked={enabled}
            onCheckedChange={() => void onToggle()}
            aria-label={t("settings.reminderEnable")}
          />
        </label>

        <Field label={t("settings.reminderAdvance")}>
          <div className="flex flex-wrap gap-2">
            {[0, 5, 10, 15, 30, 60].map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={advance === m}
                onClick={() => onAdvance(m)}
                className={cn(
                  "h-8 rounded-full border px-3 text-[12px] font-medium transition-colors duration-150",
                  advance === m
                    ? "border-brand bg-brand/10 text-brand"
                    : "border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                )}
              >
                {advanceLabel(m, t)}
              </button>
            ))}
          </div>
        </Field>

        {denied && (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            {t("settings.reminderDenied")}
          </p>
        )}

        <div>
          <Button variant="secondary" size="sm" onClick={() => void onTest()}>
            <Bell className="size-4" />
            {t("settings.reminderTest")}
          </Button>
        </div>
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

/* ── 全局 AI 提供商与资讯联网搜索 ───────────────────────── */

function AiSection({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
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
          </select>
        </div>
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
