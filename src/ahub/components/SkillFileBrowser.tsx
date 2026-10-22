import {
  AlertTriangle,
  ChevronRight,
  Code2,
  File as FileIcon,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Sheet,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/ahub/components/ui/button";
import { Markdown } from "@/ahub/components/Markdown";
import { api } from "@/ahub/lib/api";
import type { SkillFileNode } from "@/ahub/lib/types";
import { cn } from "@/ahub/lib/utils";

/** 文件类型 → 图标 */
function iconFor(node: SkillFileNode, open: boolean) {
  if (node.isDir) return open ? FolderOpen : Folder;
  switch (node.kind) {
    case "markdown":
    case "text":
      return FileText;
    case "code":
      return node.ext === "csv" ? Sheet : Code2;
    case "image":
      return FileImage;
    case "sheet":
      return FileSpreadsheet;
    case "archive":
      return FileArchive;
    default:
      return FileIcon;
  }
}

/** 类型 → 徽章色调 */
function kindTone(kind: string): string {
  switch (kind) {
    case "markdown":
      return "bg-info/12 text-info";
    case "code":
      return "bg-primary-soft text-primary";
    case "image":
      return "bg-success/12 text-success";
    case "pdf":
    case "word":
    case "sheet":
      return "bg-warning/12 text-warning";
    default:
      return "bg-surface-2 text-ink-3";
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/**
 * 技能文件浏览器：左侧目录树 + 右侧实时阅读。
 * 支持 md 渲染、代码/文本等宽显示、图片与 PDF 内联；
 * Word/表格/压缩包等无法内联的类型提供「用系统程序打开」。
 */
export function SkillFileBrowser({ dirName, className }: { dirName: string; className?: string }) {
  const { t } = useTranslation();
  const [tree, setTree] = useState<SkillFileNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string>("");
  const [content, setContent] = useState<Awaited<ReturnType<typeof api.readSkillFile>> | null>(null);
  const [reading, setReading] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const t0 = await api.listSkillFiles(dirName);
      setTree(t0);
      // 默认展开第一层目录，并选中 SKILL.md
      const firstDirs = t0.children.filter((c) => c.isDir).map((c) => c.path);
      setExpanded(new Set(firstDirs));
      const skillMd = t0.children.find((c) => c.name === "SKILL.md");
      if (skillMd) setSelected(skillMd.path);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, [dirName]);

  useEffect(() => {
    void load();
  }, [load]);

  // 选中变化 → 读取内容
  useEffect(() => {
    if (!selected) {
      setContent(null);
      return;
    }
    let alive = true;
    setReading(true);
    api
      .readSkillFile(dirName, selected)
      .then((r) => {
        if (alive) setContent(r);
      })
      .catch((e) => toast.error(String(e)))
      .finally(() => {
        if (alive) setReading(false);
      });
    return () => {
      alive = false;
    };
  }, [dirName, selected]);

  const toggleDir = (path: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });

  /** 过滤：保留命中节点及其祖先链 */
  const filteredTree = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q || !tree) return tree;
    const keep = (node: SkillFileNode): SkillFileNode | null => {
      const kids = node.children.map(keep).filter((x): x is SkillFileNode => !!x);
      const selfHit = node.name.toLowerCase().includes(q);
      if (selfHit || kids.length) {
        return { ...node, children: selfHit ? node.children : kids };
      }
      return null;
    };
    return keep(tree);
  }, [tree, filter]);

  const flatCount = useMemo(() => {
    let files = 0;
    let dirs = 0;
    const walk = (n: SkillFileNode) => {
      if (n.isDir) dirs++;
      else files++;
      n.children.forEach(walk);
    };
    if (tree) walk(tree);
    return { files, dirs: Math.max(0, dirs - 1) };
  }, [tree]);

  const renderNode = (node: SkillFileNode, depth: number) => {
    const isOpen = expanded.has(node.path);
    const isSel = selected === node.path;
    const Icon = iconFor(node, isOpen);
    return (
      <div key={node.path}>
        <button
          type="button"
          onClick={() => (node.isDir ? toggleDir(node.path) : setSelected(node.path))}
          style={{ paddingLeft: 6 + depth * 12 }}
          className={cn(
            "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[11px] outline-none transition-colors",
            isSel ? "bg-primary-soft text-primary" : "text-ink-2 hover:bg-surface-2 hover:text-foreground",
          )}
        >
          {node.isDir ? (
            <ChevronRight className={cn("size-3 shrink-0 text-ink-3 transition-transform", isOpen && "rotate-90")} />
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <Icon className={cn("size-3.5 shrink-0", isSel ? "text-primary" : "text-ink-3")} />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {!node.isDir && node.size > 0 ? (
            <span className="shrink-0 tabular-nums text-[10px] text-ink-3">{fmtSize(node.size)}</span>
          ) : null}
        </button>
        {node.isDir && isOpen ? <div>{node.children.map((c) => renderNode(c, depth + 1))}</div> : null}
      </div>
    );
  };

  return (
    <div className={cn("flex min-h-0 flex-col gap-3 lg:flex-row", className)}>
      {/* ── 目录树 ── */}
      <div className="flex w-full shrink-0 flex-col rounded-xl border border-border bg-card lg:w-72">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <FolderOpen className="size-3.5 shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
            {t("skills.filesTitle")}
          </span>
          <span className="shrink-0 tabular-nums text-[10px] text-ink-3">
            {t("skills.filesCount", { files: flatCount.files, dirs: flatCount.dirs })}
          </span>
        </div>
        <div className="border-b border-border px-3 py-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("skills.filesFilterPh")}
            className="h-7 w-full rounded-md border border-border bg-surface px-2 text-[11px] text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-ink-3 focus:border-primary focus:shadow-[0_0_0_3px_var(--ah-primary-soft)]"
          />
        </div>
        <div className="max-h-72 min-h-0 flex-1 overflow-y-auto p-1.5 lg:max-h-[52vh]">
          {loading ? (
            <div className="grid place-items-center py-8">
              <Loader2 className="size-4 animate-spin text-ink-3" />
            </div>
          ) : filteredTree && filteredTree.children.length ? (
            filteredTree.children.map((c) => renderNode(c, 0))
          ) : (
            <p className="px-2 py-6 text-center text-[11px] text-ink-3">
              {filter ? t("skills.filesNoMatch") : t("skills.filesEmpty")}
            </p>
          )}
        </div>
      </div>

      {/* ── 阅读区 ── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-border bg-card">
        {!selected ? (
          <div className="grid flex-1 place-items-center px-4 py-16 text-center">
            <div>
              <FileText className="mx-auto size-6 text-ink-3" />
              <p className="mt-2 text-xs text-ink-3">{t("skills.filesPickHint")}</p>
            </div>
          </div>
        ) : reading ? (
          <div className="grid flex-1 place-items-center py-16">
            <Loader2 className="size-4 animate-spin text-ink-3" />
          </div>
        ) : content ? (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
              <FileText className="size-3.5 shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2" dir="ltr">
                {content.path}
              </span>
              <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium", kindTone(content.kind))}>
                {content.ext || content.kind}
              </span>
              <span className="shrink-0 tabular-nums text-[10px] text-ink-3">{fmtSize(content.size)}</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 px-2 text-[10px]"
                title={t("skills.fileOpenNative")}
                onClick={() => {
                  void api
                    .openSkillFile(dirName, content.path)
                    .catch(() => toast.error(t("skills.fileOpenNativeFailed")));
                }}
              >
                {t("skills.fileOpenNative")}
              </Button>
            </div>

            {content.truncated ? (
              <div className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-1.5">
                <AlertTriangle className="size-3.5 shrink-0 text-warning" />
                <span className="text-[11px] text-warning">{content.note}</span>
              </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-auto p-3 lg:max-h-[52vh]">
              {content.kind === "markdown" ? (
                <Markdown source={content.text} className="text-xs" />
              ) : content.kind === "text" || content.kind === "code" ? (
                <pre
                  className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-2"
                  dir="ltr"
                >
                  {content.text}
                </pre>
              ) : content.kind === "image" && content.dataBase64 ? (
                <img
                  src={`data:image/${content.ext === "svg" ? "svg+xml" : content.ext};base64,${content.dataBase64}`}
                  alt={content.name}
                  className="mx-auto max-h-96 rounded-lg border border-border bg-bg-subtle object-contain"
                />
              ) : content.kind === "pdf" && content.dataBase64 ? (
                <embed
                  src={`data:application/pdf;base64,${content.dataBase64}`}
                  type="application/pdf"
                  className="h-[60vh] w-full rounded-lg border border-border"
                />
              ) : (
                <div className="grid place-items-center py-12 text-center">
                  <div>
                    <AlertTriangle className="mx-auto size-5 text-ink-3" />
                    <p className="mt-2 text-xs text-ink-3">{content.note || t("skills.fileNoPreview")}</p>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-3"
                      onClick={() => {
                        void api
                          .openSkillFile(dirName, content.path)
                          .catch(() => toast.error(t("skills.fileOpenNativeFailed")));
                      }}
                    >
                      {t("skills.fileOpenNative")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
