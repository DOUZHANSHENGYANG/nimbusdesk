import {
  Boxes,
  Brain,
  ChevronRight,
  Cloud,
  Code2,
  Hammer,
  Package,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/ahub/components/ui/input";
import { InstallButton, INSTALL_SOURCES } from "@/ahub/components/InstallButton";
import type { DiscoveredCli } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

/** 类别 → 图标。与 Rust 侧 `categorize()` 的返回值一一对应。 */
const CATEGORY_ICON: Record<string, typeof Code2> = {
  "version-control": Boxes,
  language: Code2,
  "package-manager": Package,
  container: Boxes,
  build: Hammer,
  cloud: Cloud,
  "ai-agent": Brain,
  productivity: Wrench,
  other: Terminal,
};

/** 类别展示顺序：把「用户最可能来找的」放前面。 */
const CATEGORY_ORDER = [
  "ai-agent",
  "package-manager",
  "language",
  "version-control",
  "build",
  "container",
  "cloud",
  "productivity",
  "other",
];

/** 来源标签的展示文案 key。 */
function sourceKey(source: string): string {
  if (source === "package-manager") return "envCenter.src_packageManager";
  if (source === "path") return "envCenter.src_path";
  if (source === "reference") return "envCenter.notInstalled";
  if (source === "disk-scan") return "envCenter.src_diskScan";
  return "envCenter.src_knownRoot";
}

/** `sourceDetail` 里 `|sdk` 后缀表示「随 SDK 附带」。 */
function isSdkBundled(cli: DiscoveredCli): boolean {
  return cli.sourceDetail.endsWith("|sdk");
}

export function CliToolList({
  tools,
  selected,
  onSelect,
  scanning,
  onInstalled,
}: {
  tools: DiscoveredCli[];
  selected: string | null;
  onSelect: (cli: DiscoveredCli) => void;
  scanning: boolean;
  /** 一键安装成功后回调（父组件用它刷新清单） */
  onInstalled?: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [showSdk, setShowSdk] = useState(false);

  const sdkCount = useMemo(() => tools.filter(isSdkBundled).length, [tools]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tools.filter((cli) => {
      if (!showSdk && isSdkBundled(cli)) return false;
      if (category !== "all" && cli.category !== category) return false;
      if (!q) return true;
      return (
        cli.name.toLowerCase().includes(q) ||
        cli.sourceDetail.toLowerCase().includes(q) ||
        cli.installPath.toLowerCase().includes(q)
      );
    });
  }, [tools, query, category, showSdk]);

  /** 按类别分组，保持 CATEGORY_ORDER 的顺序。 */
  const groups = useMemo(() => {
    const map = new Map<string, DiscoveredCli[]>();
    for (const cli of filtered) {
      const list = map.get(cli.category) ?? [];
      list.push(cli);
      map.set(cli.category, list);
    }
    const ordered: { key: string; items: DiscoveredCli[] }[] = [];
    for (const key of CATEGORY_ORDER) {
      const items = map.get(key);
      if (items?.length) ordered.push({ key, items });
    }
    // 未知类别兜底，不丢弃
    for (const [key, items] of map) {
      if (!CATEGORY_ORDER.includes(key)) ordered.push({ key, items });
    }
    return ordered;
  }, [filtered]);

  /** 有内容的类别才出现在筛选条里。 */
  const availableCategories = useMemo(() => {
    const present = new Set(tools.filter((c) => showSdk || !isSdkBundled(c)).map((c) => c.category));
    return CATEGORY_ORDER.filter((c) => present.has(c));
  }, [tools, showSdk]);

  const catLabel = (key: string) => {
    const map: Record<string, string> = {
      "version-control": "cat_versionControl",
      language: "cat_language",
      "package-manager": "cat_packageManager",
      container: "cat_container",
      build: "cat_build",
      cloud: "cat_cloud",
      "ai-agent": "cat_aiAgent",
      productivity: "cat_productivity",
      other: "cat_other",
    };
    return t(`envCenter.${map[key] ?? "cat_other"}`);
  };

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {/* 搜索 */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("envCenter.searchPlaceholder")}
          className="h-8 pl-8 text-[12px]"
        />
      </div>

      {/* 类别筛选 */}
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => setCategory("all")}
          className={cn(
            "rounded-md px-2 py-1 text-[11px] outline-none transition-colors",
            category === "all"
              ? "bg-primary-soft text-primary"
              : "text-ink-2 hover:bg-surface-2 hover:text-foreground",
          )}
        >
          {t("envCenter.categoryAll")}
        </button>
        {availableCategories.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setCategory(key)}
            className={cn(
              "rounded-md px-2 py-1 text-[11px] outline-none transition-colors",
              category === key
                ? "bg-primary-soft text-primary"
                : "text-ink-2 hover:bg-surface-2 hover:text-foreground",
            )}
          >
            {catLabel(key)}
          </button>
        ))}
      </div>

      {/* SDK 附带开关：只在真的存在这类工具时出现 */}
      {sdkCount > 0 ? (
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-3">
          <input
            type="checkbox"
            checked={showSdk}
            onChange={(e) => setShowSdk(e.target.checked)}
            className="size-3 accent-[var(--ah-primary)]"
          />
          {t("envCenter.showSdkCount", { n: sdkCount })}
        </label>
      ) : null}

      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-1 py-10 text-center text-[11px] leading-relaxed text-ink-3">
            {tools.length === 0
              ? scanning
                ? t("envCenter.scanning")
                : t("envCenter.emptyHint")
              : `${t("envCenter.emptyFiltered")}. ${t("envCenter.emptyFilteredHint")}`}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map(({ key, items }) => {
              const Icon = CATEGORY_ICON[key] ?? Terminal;
              return (
                <div key={key} className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 px-1">
                    <Icon className="size-3 shrink-0 text-ink-3" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                      {catLabel(key)}
                    </span>
                    <span className="text-[10px] tabular-nums text-ink-3">({items.length})</span>
                  </div>
                  {items.map((cli) => {
                    const active = selected === cli.name;
                    // 有官方 zip 源的未安装工具才显示「安装」按钮
                    const installable = !cli.installed && !!INSTALL_SOURCES[cli.name];
                    return (
                      <div key={`${cli.name}-${cli.sourceDetail}`} className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onSelect(cli)}
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors",
                            active ? "bg-primary-soft" : "hover:bg-surface-2",
                          )}
                        >
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate text-[12px] font-medium",
                              active
                                ? "text-primary"
                                : cli.installed
                                  ? "text-foreground"
                                  : "text-ink-3",
                            )}
                          >
                            {cli.name}
                          </span>
                          {cli.version ? (
                            <span className="shrink-0 font-mono text-[10px] text-ink-3">
                              {cli.version}
                            </span>
                          ) : null}
                          {/* 已安装 / 未安装：未安装的工具以灰色标签明示 */}
                          {cli.installed ? (
                            <span className="shrink-0 rounded bg-surface-2 px-1 py-0.5 text-[9px] text-ink-3">
                              {t(sourceKey(cli.source))}
                            </span>
                          ) : (
                            <span className="shrink-0 rounded bg-surface-2 px-1 py-0.5 text-[9px] text-ink-3">
                              {t("envCenter.notInstalled")}
                            </span>
                          )}
                          {isSdkBundled(cli) ? (
                            <span className="shrink-0 rounded bg-surface-2 px-1 py-0.5 text-[9px] text-ink-3">
                              SDK
                            </span>
                          ) : null}
                          <ChevronRight
                            className={cn(
                              "size-3 shrink-0",
                              active ? "text-primary" : "text-ink-3/60",
                            )}
                          />
                        </button>
                        {installable ? (
                          <InstallButton toolId={cli.name} onInstalled={onInstalled} />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
