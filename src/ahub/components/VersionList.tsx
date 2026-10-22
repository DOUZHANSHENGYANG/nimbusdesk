import { ChevronDown, Clock, FileText, GitCompare, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/ahub/components/ui/badge";
import { Button } from "@/ahub/components/ui/button";
import type { VersionEntry } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

function fmt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
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

/**
 * 行级 diff（LCS 动态规划）。
 * 技能正文通常几百行，O(n·m) 完全够用；超长内容退化为整体替换以免卡顿。
 */
type DiffRow = { type: "same" | "add" | "del"; text: string };

const MAX_LINES = 2000;

function diffLines(a: string, b: string): DiffRow[] {
  // 空字符串代表「没有内容」，按 0 行处理，避免凭空多出一行差异
  const la = a === "" ? [] : a.split("\n");
  const lb = b === "" ? [] : b.split("\n");
  if (la.length > MAX_LINES || lb.length > MAX_LINES) {
    return [
      ...la.map((text) => ({ type: "del" as const, text })),
      ...lb.map((text) => ({ type: "add" as const, text })),
    ];
  }
  // LCS 表（滚动两行即可，但回溯需要全表 → 用 Int32Array 扁平存储）
  const n = la.length;
  const m = lb.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        la[i] === lb[j] ? dp[(i + 1) * w + (j + 1)] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (la[i] === lb[j]) {
      out.push({ type: "same", text: la[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      out.push({ type: "del", text: la[i] });
      i++;
    } else {
      out.push({ type: "add", text: lb[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: la[i++] });
  while (j < m) out.push({ type: "add", text: lb[j++] });
  return out;
}

function diffStat(rows: DiffRow[]) {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.type === "add") added++;
    else if (r.type === "del") removed++;
  }
  return { added, removed };
}

/** 只显示变更附近的行，省空间 */
function collapseContext(rows: DiffRow[], padding = 2): (DiffRow | { type: "gap"; text: string })[] {
  const keep = new Set<number>();
  rows.forEach((r, i) => {
    if (r.type === "same") return;
    for (let k = i - padding; k <= i + padding; k++) if (k >= 0 && k < rows.length) keep.add(k);
  });
  const out: (DiffRow | { type: "gap"; text: string })[] = [];
  let skipping = false;
  rows.forEach((r, i) => {
    if (keep.has(i)) {
      out.push(r);
      skipping = false;
    } else if (!skipping) {
      out.push({ type: "gap", text: "…" });
      skipping = true;
    }
  });
  return out;
}

function DiffView({ rows, baseLabel }: { rows: DiffRow[]; baseLabel: string }) {
  const { t } = useTranslation();
  const shown = useMemo(() => collapseContext(rows), [rows]);
  const stat = diffStat(rows);

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-border bg-bg-subtle">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <GitCompare className="size-3.5 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-3">
          {t("skills.verDiffTitle")} · {baseLabel}
        </span>
        {stat.added || stat.removed ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            <span className="text-success">{t("skills.verAdded", { n: stat.added })}</span>{" "}
            <span className="text-danger">{t("skills.verRemoved", { n: stat.removed })}</span>
          </span>
        ) : (
          <span className="shrink-0 text-[11px] text-ink-3">{t("skills.verDiffEmpty")}</span>
        )}
      </div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full border-collapse font-mono text-[11px] leading-5" dir="ltr">
          <tbody>
            {shown.map((r, i) =>
              r.type === "gap" ? (
                <tr key={i} className="text-ink-3">
                  <td className="w-8 select-none border-r border-border px-1 text-right opacity-40">·</td>
                  <td className="px-2 py-0.5 opacity-40">⋯</td>
                </tr>
              ) : (
                <tr
                  key={i}
                  className={cn(
                    r.type === "add" && "bg-success/10",
                    r.type === "del" && "bg-danger/10",
                  )}
                >
                  <td
                    className={cn(
                      "w-8 select-none border-r border-border px-1 text-right",
                      r.type === "add" ? "text-success" : r.type === "del" ? "text-danger" : "text-ink-3 opacity-40",
                    )}
                  >
                    {r.type === "add" ? "+" : r.type === "del" ? "−" : ""}
                  </td>
                  <td
                    className={cn(
                      "whitespace-pre-wrap break-all px-2 py-0.5",
                      r.type === "same" ? "text-ink-2" : "text-foreground",
                    )}
                  >
                    {r.text || " "}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * 版本时间轴：纵向轴 + 节点，含「当前内容」顶点。
 * 每条快照可展开与当前/上一版的逐行差异，并一键恢复。
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

  // 时间轴：新 → 旧
  const list = useMemo(() => [...versions].sort((a, b) => b.v - a.v), [versions]);
  const cur = current ?? "";
  // 当前正文与最新发布版本是否已经不一致 —— 用于给顶点打「未发布」标记
  // 注意用 bodyOf：技能的版本快照存的是整份 SKILL.md（含 frontmatter），
  // 而传进来的 current 只是正文。直接比会永远判为"有改动"。
  const dirty = list.length > 0 && bodyOf(cur) !== bodyOf(list[0].content);

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
        <div className={cn("relative px-4 pb-4 pt-3", fill && "min-h-0 flex-1 overflow-y-auto")}>
          {/* 时间轴竖线 */}
          <span className="absolute bottom-4 left-[15px] top-3 w-px bg-border" aria-hidden />

          {/* 顶点：当前内容 */}
          <div className="relative mb-1 flex items-start gap-3">
            <span className="relative z-10 mt-1 grid size-4 shrink-0 place-items-center rounded-full border-2 border-success bg-card">
              <span className="size-1.5 rounded-full bg-success" />
            </span>
            <div className="min-w-0 flex-1">
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
            </div>
          </div>

          {list.map((v, idx) => {
            const expanded = open === v.v;
            // 上一版 = 时间轴上更早的一条（列表里 idx+1）
            const prev = list[idx + 1];
            const baseContent = base === "current" ? cur : (prev?.content ?? "");
            const baseLabel =
              base === "current" ? t("skills.verDiffVsCurrent") : `${t("skills.verDiffVsPrev")} v${prev?.v ?? "-"}`;
            const rows = expanded ? diffLines(bodyOf(v.content), bodyOf(baseContent)) : [];

            return (
              <div key={v.v} className="relative flex items-start gap-3 pb-1 pt-2">
                <span
                  className={cn(
                    "relative z-10 mt-1 size-4 shrink-0 rounded-full border-2 bg-card transition-colors",
                    idx === 0 ? "border-primary" : "border-border-strong",
                  )}
                >
                  {idx === 0 ? <span className="absolute inset-[3px] rounded-full bg-primary" /> : null}
                </span>

                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : v.v)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left outline-none transition-colors hover:bg-surface-2"
                  >
                    <span className="shrink-0 rounded-md bg-primary-soft px-2 py-0.5 font-mono text-[11px] font-medium text-primary">
                      v{v.v}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      {v.note || <span className="text-ink-3">{t("skills.versionNoNote")}</span>}
                    </span>
                    <span className="shrink-0 tabular-nums text-[11px] text-ink-3">{fmt(v.savedAt)}</span>
                    <span className="hidden shrink-0 text-[11px] text-ink-3 sm:inline">{fmtSize(v.content.length)}</span>
                    <ChevronDown className={cn("size-3.5 shrink-0 text-ink-3 transition-transform", expanded && "rotate-180")} />
                  </button>

                  {expanded ? (
                    <div className="px-2 pb-2">
                      {/* 对比基准切换 */}
                      <div className="mt-1 flex items-center gap-2">
                        <span className="text-[11px] text-ink-3">{t("skills.verDiffBase")}</span>
                        <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5">
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
                                "rounded-md px-2 py-0.5 text-[11px] font-medium outline-none transition-colors disabled:opacity-40",
                                base === bv ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
                              )}
                            >
                              {t(key)}
                            </button>
                          ))}
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="ml-auto h-7 shrink-0 px-2.5 text-[11px]"
                          onClick={() => onRestore(v.content)}
                        >
                          <RotateCcw className="size-3" />
                          {t("common.restore")}
                        </Button>
                      </div>

                      <DiffView rows={rows} baseLabel={baseLabel} />
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
