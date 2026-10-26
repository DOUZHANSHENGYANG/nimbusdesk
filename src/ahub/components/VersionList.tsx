import { ChevronDown, Clock, FileText, GitCompare, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactDiffViewer from "react-diff-viewer-continued";
import { VerticalTimeline, VerticalTimelineElement } from "react-vertical-timeline-component";
import "react-vertical-timeline-component/style.min.css";
import "@/ahub/styles/version-timeline.css";
import { Badge } from "@/ahub/components/ui/badge";
import { Button } from "@/ahub/components/ui/button";
import { Markdown } from "@/ahub/components/Markdown";
import type { VersionEntry } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

function fmt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    // 竖栏里空间紧：到分钟即可，秒和年份以外的长格式都省掉
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

/** 去掉 frontmatter，只留正文 */
function bodyOf(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n\n?/, "");
}

/** diff 配色全部走 token：库只接受颜色字符串，用 var() 传进去，主题切换自动跟随 */
const DIFF_STYLES = {
  variables: {
    dark: {
      diffViewerBackground: "var(--surface)",
      diffViewerColor: "var(--ink-2, var(--muted-foreground))",
      diffViewerTitleBackground: "var(--surface-2, var(--surface))",
      diffViewerTitleColor: "var(--ink-3, var(--muted-foreground))",
      diffViewerTitleBorderColor: "var(--border)",
      addedBackground: "color-mix(in oklab, var(--success) 12%, transparent)",
      addedColor: "var(--success)",
      removedBackground: "color-mix(in oklab, var(--danger) 12%, transparent)",
      removedColor: "var(--danger)",
      changedBackground: "color-mix(in oklab, var(--warning) 12%, transparent)",
      wordAddedBackground: "color-mix(in oklab, var(--success) 26%, transparent)",
      wordRemovedBackground: "color-mix(in oklab, var(--danger) 26%, transparent)",
      addedGutterBackground: "color-mix(in oklab, var(--success) 18%, transparent)",
      removedGutterBackground: "color-mix(in oklab, var(--danger) 18%, transparent)",
      gutterBackground: "var(--surface)",
      gutterBackgroundDark: "var(--surface)",
      gutterColor: "var(--ink-3, var(--muted-foreground))",
      addedGutterColor: "var(--success)",
      removedGutterColor: "var(--danger)",
      codeFoldGutterBackground: "var(--surface)",
      codeFoldBackground: "var(--surface)",
      emptyLineBackground: "var(--surface)",
      codeFoldContentColor: "var(--ink-3, var(--muted-foreground))",
      highlightBackground: "color-mix(in oklab, var(--primary) 10%, transparent)",
      highlightGutterBackground: "color-mix(in oklab, var(--primary) 16%, transparent)",
    },
  },
  diffContainer: { fontSize: "11px", fontFamily: "var(--font-mono, ui-monospace, monospace)" },
  contentText: { lineHeight: "1.45" },
  // 库里那条「变更块缩略条」在窄栏里只显得吵，关掉
  block: { display: "none" },
  blockAddition: { display: "none" },
  blockDeletion: { display: "none" },
  allExpandButton: { display: "none" },
  codeFoldGutter: { display: "none" },
} as const;

/** 竖栏里塞不下左右两栏，用统一视图；行号保留，方便对「第几行变了」 */
function DiffView({ from, to, title }: { from: string; to: string; title: string }) {
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  return (
    <div className="mt-2 w-full min-w-0 overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
        <GitCompare className="size-3 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-ink-3">{title}</span>
      </div>
      <div className="ahub-diff max-h-64 w-full min-w-0 overflow-auto">
        <ReactDiffViewer
          oldValue={from}
          newValue={to}
          splitView={false}
          useDarkTheme={dark}
          showDiffOnly={false}
          styles={DIFF_STYLES as never}
        />
      </div>
    </div>
  );
}

/**
 * 版本时间轴：库（react-vertical-timeline-component）负责竖线/节点/卡片与展开动画，
 * 逐行差异交给 react-diff-viewer-continued（语法高亮、词级高亮、可折叠上下文）。
 * 这里只剩「我们的业务」：版本号、备注、当前内容是否未发布、恢复与清空。
 */
export function VersionList({
  versions,
  current,
  onRestore,
  onClear,
  onSeed,
  className,
  fill,
}: {
  versions: VersionEntry[];
  /** 当前正文（用于生成「对比当前」的差异） */
  current?: string;
  onRestore: (content: string) => void;
  onClear?: () => void;
  /** 无版本记录时的兜底动作：补一条初始版本 */
  onSeed?: () => void;
  className?: string;
  /**
   * 撑满父容器剩余高度，内容区独立滚动。
   * 用在外层已是「固定高度 + 纵向布局」的场景（如提示词编辑器右侧栏），
   * 否则这张卡片会按内容高度收缩，把下方的空白留在外面。
   */
  fill?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<number | null>(null);
  const [base, setBase] = useState<"current" | "prev">("current");
  /** 展开某一版先给「预览」（渲染后的正文），要比对才切「差异」 */
  const [mode, setMode] = useState<"preview" | "diff">("preview");

  // 时间轴：新 → 旧
  const list = useMemo(() => [...versions].sort((a, b) => b.v - a.v), [versions]);
  const cur = current ?? "";
  // 当前正文与最新发布版本是否已经不一致 —— 用于给顶点打「未发布」标记
  // 注意用 bodyOf：技能的版本快照存的是整份 SKILL.md（含 frontmatter），
  // 而传进来的 current 只是正文。直接比会永远判为"有改动"。
  const dirty = list.length > 0 && bodyOf(cur) !== bodyOf(list[0].content);

  const icon = (tone: "success" | "primary" | "muted") => (
    <span
      className={cn(
        "block size-2.5 rounded-full",
        tone === "success" ? "bg-success" : tone === "primary" ? "bg-primary" : "bg-border-strong",
      )}
    />
  );

  const elementProps = (tone: "success" | "primary" | "muted") => ({
    iconStyle: {
      background: "var(--surface)",
      color: "var(--primary)",
      boxShadow: "none",
      width: 16,
      height: 16,
      marginLeft: -8,
      display: "grid",
      placeItems: "center",
      border: "1px solid var(--border)",
    } as const,
    contentStyle: { background: "var(--surface)" },
    contentArrowStyle: { borderRight: "6px solid var(--border)" },
    icon: icon(tone),
  });

  return (
    <div
      className={cn(
        // fill 时由 flex-1 接管尺寸；非 fill 时保持原有的「按内容收缩、不被压缩」
        "rounded-xl border border-border bg-card",
        fill ? "flex min-h-0 flex-1 flex-col" : "shrink-0",
        className,
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <h3 className="flex min-w-0 flex-1 items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
          <Clock className="size-3.5" />
          {t("skills.verTree")}
          {versions.length ? <Badge variant="muted">{versions.length}</Badge> : null}
        </h3>
        {onClear && versions.length ? (
          <button
            type="button"
            title={t("settings.vaultClear")}
            onClick={onClear}
            className="shrink-0 rounded-md p-1.5 text-ink-3 outline-none transition-colors hover:bg-danger/10 hover:text-danger"
          >
            <Trash2 className="size-3.5" />
          </button>
        ) : null}
      </div>

      {versions.length === 0 ? (
        // fill 模式下空状态也占满剩余空间：卡片已承诺「这块地方归时间轴」，
        // 里面留一大片空白比贴一行字更奇怪。
        <div className={cn("flex items-start gap-2 px-4 py-3", fill && "min-h-0 flex-1")}>
          <FileText className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
          <div className="min-w-0">
            <p className="text-[11px] leading-relaxed text-ink-3">{t("skills.versionEmptyHint")}</p>
            {onSeed ? (
              <button
                type="button"
                onClick={onSeed}
                className="mt-1.5 rounded-md text-[11px] font-medium text-primary outline-none hover:underline"
              >
                {t("skills.seedVersionBtn")}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className={cn("ahub-vt px-3 pb-3 pt-2", fill && "min-h-0 flex-1 overflow-y-auto")}>
          <VerticalTimeline layout="1-column-left" animate={false} className="vertical-timeline--one-column">
            {/* 顶点：当前内容 */}
            <VerticalTimelineElement {...elementProps(dirty ? "muted" : "success")}>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "rounded-md px-2 py-0.5 font-mono text-[11px] font-medium",
                    dirty ? "bg-warning/12 text-warning" : "bg-success/12 text-success",
                  )}
                >
                  {t("skills.verCurrent")}
                </span>
                {dirty ? <span className="text-[11px] font-medium text-warning">{t("prompts.statusDirty")}</span> : null}
                <span className="text-[11px] text-ink-3">{t("skills.body")}</span>
                <span className="ml-auto shrink-0 text-[11px] text-ink-3">{fmtSize(cur.length)}</span>
              </div>
            </VerticalTimelineElement>

            {list.map((v, idx) => {
              const expanded = open === v.v;
              // 上一版 = 时间轴上更早的一条（列表里 idx+1）
              const prev = list[idx + 1];
              const baseContent = base === "current" ? cur : (prev?.content ?? "");
              const baseLabel =
                base === "current" ? t("skills.verDiffVsCurrent") : `${t("skills.verDiffVsPrev")} v${prev?.v ?? "-"}`;

              return (
                <VerticalTimelineElement key={v.v} {...elementProps(idx === 0 ? "primary" : "muted")}>
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : v.v)}
                    className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left outline-none transition-colors hover:bg-surface-2"
                  >
                    <span className="shrink-0 rounded bg-primary-soft px-1.5 py-0.5 font-mono text-[11px] font-medium text-primary">
                      v{v.v}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground">
                      {v.note || <span className="text-ink-3">{t("skills.versionNoNote")}</span>}
                    </span>
                    <span className="shrink-0 tabular-nums text-[10.5px] text-ink-3">{fmt(v.savedAt)}</span>
                    <span className="shrink-0 text-[10.5px] text-ink-3">{fmtSize(v.content.length)}</span>
                    <ChevronDown className={cn("size-3.5 shrink-0 text-ink-3 transition-transform", expanded && "rotate-180")} />
                  </button>

                  {expanded ? (
                    <div className="mt-1.5">
                      {/* 默认看「预览」：渲染后的 Markdown。要比对再切「差异」——
                          差异视图那两列行号在窄栏里挤成一团，读起来很累。 */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        <div className="flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5">
                          {(
                            [
                              { v: "preview", key: "skills.modePreview" },
                              { v: "diff", key: "skills.verDiff" },
                            ] as const
                          ).map(({ v: mv, key }) => (
                            <button
                              key={mv}
                              type="button"
                              onClick={() => setMode(mv)}
                              className={cn(
                                "rounded px-1.5 py-0.5 text-[10.5px] font-medium outline-none transition-colors",
                                mode === mv ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
                              )}
                            >
                              {t(key)}
                            </button>
                          ))}
                        </div>

                        {/* 对比基准：只在差异模式下有意义 */}
                        {mode === "diff" ? (
                          <div className="flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5">
                            {(
                              [
                                { v: "current", key: "skills.verDiffVsCurrent" },
                                { v: "prev", key: "skills.verDiffVsPrev" },
                              ] as const
                            ).map(({ v: bv, key }) => (
                              <button
                                key={bv}
                                type="button"
                                disabled={bv === "prev" && !prev}
                                onClick={() => setBase(bv)}
                                className={cn(
                                  "rounded px-1.5 py-0.5 text-[10.5px] font-medium outline-none transition-colors disabled:opacity-40",
                                  base === bv ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
                                )}
                              >
                                {t(key)}
                              </button>
                            ))}
                          </div>
                        ) : null}

                        <Button
                          size="sm"
                          variant="secondary"
                          className="ml-auto h-6 shrink-0 px-2 text-[10.5px]"
                          onClick={() => onRestore(v.content)}
                        >
                          <RotateCcw className="size-3" />
                          {t("common.restore")}
                        </Button>
                      </div>

                      {mode === "preview" ? (
                        <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-border bg-bg-subtle p-3">
                          <Markdown source={bodyOf(v.content)} />
                        </div>
                      ) : (
                        <DiffView from={bodyOf(baseContent)} to={bodyOf(v.content)} title={`${t("skills.verDiffTitle")} · ${baseLabel}`} />
                      )}
                    </div>
                  ) : null}
                </VerticalTimelineElement>
              );
            })}
          </VerticalTimeline>
        </div>
      )}
    </div>
  );
}
