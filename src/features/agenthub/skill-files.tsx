import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronRight, Code2, File as FileIcon, FileArchive, FileImage, FileSpreadsheet, FileText, Folder, FolderOpen, Loader2, Sheet } from "lucide-react";
import { cn } from "@/lib/utils";
import { tbSkillListFiles, tbSkillReadFile, type TbSkillFileContent, type TbSkillFileNode } from "./api";
import { fileErrorCode, filterTree, sizeLabel, FILE_ERROR_KEYS } from "./core";
import { MarkdownView } from "./shared/markdown";

/** 文件类型 → 图标（与源侧同一张表） */
function iconFor(node: TbSkillFileNode, open: boolean) {
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

/**
 * 技能文件浏览器：目录树 + 实时阅读。**只读** —— 这里没有任何写回磁盘的动作，
 * 辅助文件用别的编辑器改更合适（技能页只提供「在资源管理器中显示」）。
 *
 * 与源侧的差异（后端能力的差异，不是漏做）：
 * - 只读文本：图片/PDF 需要把字节 base64 塞回前端，这里不做；非文本文件只列出，
 *   点开会说明「不是文本，不能在这里预览」，要去系统里打开请用资源管理器按钮。
 * - 不截断：源侧超过 2 MB 只给前 2 MB，这里改成明确报错 —— 看一半的正文比
 *   看不了更容易被当成完整内容。
 * - 树在窄栏里纵向排（源侧在宽弹窗里是左右两栏），这是详情面板宽度的差异。
 */
export function SkillFileBrowser({ dirName }: { dirName: string }) {
  const { t } = useTranslation();
  const [tree, setTree] = useState<TbSkillFileNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<TbSkillFileNode | null>(null);
  const [content, setContent] = useState<TbSkillFileContent | null>(null);
  const [readFailure, setReadFailure] = useState("");
  const [reading, setReading] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setSelected(null);
    setContent(null);
    setReadFailure("");
    setFilter("");
    tbSkillListFiles(dirName)
      .then((next) => {
        if (!alive) return;
        setTree(next);
        // 默认展开第一层目录，并选中 SKILL.md —— 打开就该看到技能本体
        setExpanded(new Set(next.children.filter((c) => c.isDir).map((c) => c.path)));
        setSelected(next.children.find((c) => c.name === "SKILL.md") ?? null);
        setFailure("");
      })
      .catch((error) => {
        if (alive) setFailure(String(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [dirName]);

  // 选中变化 → 读内容。非文本文件连请求都不发
  useEffect(() => {
    if (!selected) return;
    if (!selected.isText) {
      setContent(null);
      setReadFailure("");
      return;
    }
    let alive = true;
    setReading(true);
    setReadFailure("");
    tbSkillReadFile(dirName, selected.path)
      .then((next) => {
        if (alive) setContent(next);
      })
      .catch((error) => {
        if (alive) {
          setContent(null);
          setReadFailure(String(error));
        }
      })
      .finally(() => {
        if (alive) setReading(false);
      });
    return () => {
      alive = false;
    };
  }, [dirName, selected]);

  const shown = useMemo(() => (tree && filter.trim() ? filterTree(tree, filter) : tree), [tree, filter]);

  const counts = useMemo(() => {
    let files = 0;
    let dirs = 0;
    const walk = (node: TbSkillFileNode) => {
      if (node.isDir) dirs++;
      else files++;
      node.children.forEach(walk);
    };
    if (tree) walk(tree);
    return { files, dirs: Math.max(0, dirs - 1) }; // 根节点本身不是「子目录」
  }, [tree]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const row = (node: TbSkillFileNode, depth: number) => {
    const open = expanded.has(node.path);
    const active = selected?.path === node.path;
    const Icon = iconFor(node, open);
    return (
      <div key={node.path}>
        <button
          type="button"
          onClick={() => (node.isDir ? toggle(node.path) : setSelected(node))}
          style={{ paddingLeft: 6 + depth * 12 }}
          className={cn(
            "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[11px] outline-none transition-colors",
            active ? "bg-primary-soft text-primary" : "text-ink-2 hover:bg-surface-2 hover:text-foreground",
          )}
        >
          {node.isDir ? (
            <ChevronRight className={cn("size-3 shrink-0 text-ink-3 transition-transform", open && "rotate-90")} />
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <Icon className={cn("size-3.5 shrink-0", active ? "text-primary" : "text-ink-3")} />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {!node.isDir && node.size > 0 ? (
            <span className="shrink-0 tabular-nums text-[10px] text-ink-3">{sizeLabel(node.size)}</span>
          ) : null}
        </button>
        {node.isDir && open ? <div>{node.children.map((child) => row(child, depth + 1))}</div> : null}
      </div>
    );
  };

  /** 读失败：认得码就翻译，认不出来就把原文摆出来 */
  const failureText = (message: string) => {
    const code = fileErrorCode(message);
    return code ? t(FILE_ERROR_KEYS[code]) : message;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* ── 目录树 ── */}
      <div className="flex shrink-0 flex-col rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <FolderOpen className="size-3.5 shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-ink-3">{t("toolbox.files.title")}</span>
          <span className="shrink-0 tabular-nums text-[10px] text-ink-3">{t("toolbox.files.count", { files: counts.files, dirs: counts.dirs })}</span>
        </div>
        <div className="border-b border-border px-3 py-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("toolbox.files.filter")}
            className="h-7 w-full rounded-md border border-border bg-surface px-2 text-[11px] text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-ink-3 focus:border-primary focus:shadow-[0_0_0_3px_var(--accent)]"
          />
        </div>
        <div className="max-h-56 min-h-0 overflow-y-auto p-1.5">
          {loading ? (
            <div className="grid place-items-center py-8">
              <Loader2 className="size-4 animate-spin text-ink-3" />
            </div>
          ) : failure ? (
            <p className="px-2 py-6 text-center text-[11px] text-destructive">{failure}</p>
          ) : shown && shown.children.length ? (
            <>
              {shown.children.map((child) => row(child, 0))}
              {tree?.truncated ? <p className="px-2 py-1.5 text-[10px] text-warning">{t("toolbox.files.truncated")}</p> : null}
            </>
          ) : (
            <p className="px-2 py-6 text-center text-[11px] text-ink-3">{filter ? t("toolbox.files.noMatch") : t("toolbox.files.empty")}</p>
          )}
        </div>
      </div>

      {/* ── 阅读区 ── */}
      <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-card">
        {!selected ? (
          <div className="grid flex-1 place-items-center px-4 py-10 text-center">
            <div>
              <FileText className="mx-auto size-6 text-ink-3" />
              <p className="mt-2 text-xs text-ink-3">{t("toolbox.files.pick")}</p>
            </div>
          </div>
        ) : !selected.isText ? (
          <div className="grid flex-1 place-items-center px-4 py-10 text-center">
            <div>
              <AlertTriangle className="mx-auto size-5 text-ink-3" />
              <p className="mt-2 text-xs text-ink-3">{t("toolbox.files.notText")}</p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
              <FileText className="size-3.5 shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2" dir="ltr">
                {selected.path}
              </span>
              <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium", kindTone(selected.kind))}>
                {selected.ext || selected.kind}
              </span>
              <span className="shrink-0 tabular-nums text-[10px] text-ink-3">{sizeLabel(selected.size)}</span>
            </div>
            {reading ? (
              <div className="grid flex-1 place-items-center py-10">
                <Loader2 className="size-4 animate-spin text-ink-3" />
              </div>
            ) : readFailure ? (
              <div className="grid flex-1 place-items-center px-4 py-10 text-center">
                <div>
                  <AlertTriangle className="mx-auto size-5 text-warning" />
                  <p className="mt-2 text-xs text-warning">{failureText(readFailure)}</p>
                </div>
              </div>
            ) : content ? (
              <div className="min-h-0 flex-1 overflow-auto p-3">
                {content.kind === "markdown" ? (
                  <MarkdownView source={content.text} className="text-xs" />
                ) : (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-2" dir="ltr">
                    {content.text}
                  </pre>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
