import { ChevronDown, Clock, FileText, GitCompare, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/motion/button/base";
import { cn } from "@/lib/utils";
import { bodyOf, collapseContext, diffLines, diffStat, type DiffRow } from "../core";
import type { TbVersion } from "../api";

function fmt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
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
          {t("toolbox.versionList.diffTitle")} · {baseLabel}
        </span>
        {stat.added || stat.removed ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            <span className="text-success">{t("toolbox.versionList.added", { n: stat.added })}</span>{" "}
            <span className="text-danger">{t("toolbox.versionList.removed", { n: stat.removed })}</span>
          </span>
        ) : (
          <span className="shrink-0 text-[11px] text-ink-3">{t("toolbox.versionList.diffEmpty")}</span>
        )}
      </div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full border-collapse font-mono text-[11px] leading-5" dir="ltr">
          <tbody>
            {shown.map((row, i) =>
              row.type === "gap" ? (
                <tr key={i} className="text-ink-3">
                  <td className="w-8 select-none border-r border-border px-1 text-right opacity-40">·</td>
                  <td className="px-2 py-0.5 opacity-40">⋯</td>
                </tr>
              ) : (
                <tr key={i} className={cn(row.type === "add" && "bg-success/10", row.type === "del" && "bg-danger/10")}>
                  <td
                    className={cn(
                      "w-8 select-none border-r border-border px-1 text-right",
                      row.type === "add" ? "text-success" : row.type === "del" ? "text-danger" : "text-ink-3 opacity-40",
                    )}
                  >
                    {row.type === "add" ? "+" : row.type === "del" ? "−" : ""}
                  </td>
                  <td className={cn("whitespace-pre-wrap break-all px-2 py-0.5", row.type === "same" ? "text-ink-2" : "text-foreground")}>
                    {row.text || " "}
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
 * 版本时间轴：纵向轴 + 节点，含「当前内容」顶点；每条快照可展开与当前/上一版的
 * 逐行差异，并一键回滚。
 *
 * 与源侧的两处差异（都是有意的）：
 * - 回滚是**后端**做的（`tb_*_restore`），这里只上报「要回滚到哪一版」。
 *   源侧把版本内容写回编辑框、等用户再点保存，等于同一次回滚要两步。
 * - 没有「补一条初始版本」「清空版本」两个动作：云台后端还不提供，宁可不放按钮，
 *   也不放一个点了报错的按钮。
 */
export function VersionList({
  versions,
  current,
  onRestore,
  className,
  fill,
}: {
  versions: TbVersion[];
  /** 当前正文（用于生成「对比当前」的差异） */
  current?: string;
  onRestore: (version: TbVersion) => void;
  className?: string;
  /** 撑满父容器剩余高度，内容区独立滚动（外层已是固定高度 + 纵向布局时用） */
  fill?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<number | null>(null);
  const [base, setBase] = useState<"current" | "prev">("current");

  // 时间轴：新 → 旧
  const list = useMemo(() => [...versions].sort((a, b) => b.v - a.v), [versions]);
  const cur = current ?? "";
  // 版本快照存的是整份 SKILL.md（含 frontmatter），而 current 只是正文 —— 先剥再比
  const dirty = list.length > 0 && bodyOf(cur) !== bodyOf(list[0].content);

  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card",
        fill ? "flex min-h-0 flex-1 flex-col" : "shrink-0",
        className,
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <h3 className="flex min-w-0 flex-1 items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
          <Clock className="size-3.5" />
          {t("toolbox.versionList.tree")}
          {versions.length ? <Badge variant="secondary">{versions.length}</Badge> : null}
        </h3>
      </div>

      {versions.length === 0 ? (
        <div className={cn("flex items-start gap-2 px-4 py-3", fill && "min-h-0 flex-1")}>
          <FileText className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
          <p className="min-w-0 text-[11px] leading-relaxed text-ink-3">{t("toolbox.versionList.emptyHint")}</p>
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
                  {t("toolbox.versionList.current")}
                </span>
                {dirty ? <span className="text-[11px] font-medium text-warning">{t("toolbox.versionList.dirty")}</span> : null}
                <span className="text-[11px] text-ink-3">{t("toolbox.versionList.body")}</span>
                <span className="ml-auto shrink-0 text-[11px] text-ink-3">{fmtSize(cur.length)}</span>
              </div>
            </div>
          </div>

          {list.map((version, idx) => {
            const expanded = open === version.v;
            const prev = list[idx + 1];
            const baseContent = base === "current" ? cur : (prev?.content ?? "");
            const baseLabel =
              base === "current"
                ? t("toolbox.versionList.diffVsCurrent")
                : `${t("toolbox.versionList.diffVsPrev")} v${prev?.v ?? "-"}`;
            const rows = expanded ? diffLines(bodyOf(version.content), bodyOf(baseContent)) : [];

            return (
              <div key={version.v} className="relative flex items-start gap-3 pb-1 pt-2">
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
                    onClick={() => setOpen(expanded ? null : version.v)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left outline-none transition-colors hover:bg-surface-2"
                  >
                    <span className="shrink-0 rounded-md bg-primary-soft px-2 py-0.5 font-mono text-[11px] font-medium text-primary">
                      v{version.v}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      {version.note || <span className="text-ink-3">{t("toolbox.versionList.noNote")}</span>}
                    </span>
                    <span className="shrink-0 tabular-nums text-[11px] text-ink-3">{fmt(version.savedAt)}</span>
                    <span className="hidden shrink-0 text-[11px] text-ink-3 sm:inline">{fmtSize(version.content.length)}</span>
                    <ChevronDown className={cn("size-3.5 shrink-0 text-ink-3 transition-transform", expanded && "rotate-180")} />
                  </button>

                  {expanded ? (
                    <div className="px-2 pb-2">
                      <div className="mt-1 flex items-center gap-2">
                        <span className="text-[11px] text-ink-3">{t("toolbox.versionList.diffBase")}</span>
                        <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5">
                          {(
                            [
                              { value: "current", key: "toolbox.versionList.diffVsCurrent" },
                              { value: "prev", key: "toolbox.versionList.diffVsPrev" },
                            ] as const
                          ).map(({ value, key }) => (
                            <button
                              key={value}
                              type="button"
                              disabled={value === "prev" && !prev}
                              onClick={() => setBase(value)}
                              className={cn(
                                "rounded-md px-2 py-0.5 text-[11px] font-medium outline-none transition-colors disabled:opacity-40",
                                base === value ? "bg-primary-soft text-primary" : "text-ink-3 hover:text-foreground",
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
                          onClick={() => onRestore(version)}
                        >
                          <RotateCcw className="size-3" />
                          {t("toolbox.restore")}
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
