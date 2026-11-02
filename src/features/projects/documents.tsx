import { useEffect, useState } from "react";
import { FilePlus2, FileText, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createProjectEntry, listProjectFiles, openProjectFile, writeProjectText } from "./api";
import { useProjectsCopy } from "./copy";
import { DOC_SLOTS, createdSlots, type DocKind } from "./doc-templates";
import { inTauri } from "@/lib/tauri";

/**
 * 项目文档槽位：五个固定文件放在项目目录的 docs/ 下。
 *
 * 只做两件事——「用模板建出来」和「打开它」，编辑交给项目文件区（同一目录）或系统默认程序。
 * 槽位状态每次挂载时从磁盘读，不落库：文件才是真源，删掉/改名就回到未创建。
 */
export function ProjectDocuments({ projectId, folder }: { projectId: string; folder: string | null }) {
  const c = useProjectsCopy();
  const [paths, setPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState<DocKind | "all" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!folder || !inTauri) { setPaths([]); return; }
    let alive = true;
    listProjectFiles(projectId, "docs")
      .then(files => { if (alive) setPaths(files.filter(file => !file.directory).map(file => file.path)); })
      .catch(() => { if (alive) setPaths([]); });
    return () => { alive = false; };
  }, [projectId, folder]);

  const created = createdSlots(paths);
  const title = (kind: DocKind) => c[`doc${kind[0].toUpperCase()}${kind.slice(1)}` as keyof typeof c] as string;
  const hint = (kind: DocKind) => c[`doc${kind[0].toUpperCase()}${kind.slice(1)}Hint` as keyof typeof c] as string;

  async function create(kind: DocKind) {
    const slot = DOC_SLOTS.find(entry => entry.kind === kind)!;
    const name = slot.path.split("/").pop()!.replace(/\.md$/, "");
    // 目录可能还不存在：先建 docs/，已存在时的报错直接吞掉。
    try { await createProjectEntry(projectId, "", "docs", "folder"); } catch { /* 已存在 */ }
    const path = await createProjectEntry(projectId, "docs", name, "markdown");
    await writeProjectText(projectId, path, "", slot.body);
    setPaths(current => [...current, path]);
    return path;
  }

  async function run(target: DocKind | "all") {
    setBusy(target); setError("");
    try {
      if (target === "all") {
        // 只补缺的：已有内容不会被模板覆盖。
        for (const slot of DOC_SLOTS) if (!created.has(slot.kind)) await create(slot.kind);
      } else if (created.has(target)) {
        await openProjectFile(projectId, DOC_SLOTS.find(entry => entry.kind === target)!.path);
      } else {
        await create(target);
      }
    } catch (failure) {
      setError(`${c.docFailed} ${String(failure).slice(0, 120)}`);
    } finally { setBusy(null); }
  }

  // 没绑目录时什么都不画：下面文件区的空状态已经在说这件事，两处提示只会互相打架。
  if (!folder) return null;

  const pending = DOC_SLOTS.some(slot => !created.has(slot.kind));
  return <section aria-label={c.documents} className="mb-3">
    <div className="mb-1.5 flex items-center justify-between gap-2">
      <h2 className="text-[11px] font-medium text-muted-foreground">{c.documents}</h2>
      {pending && <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px] text-muted-foreground" disabled={busy !== null} onClick={() => void run("all")}>{busy === "all" ? <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" /> : <FilePlus2 className="size-3" />}{c.docCreateAll}</Button>}
    </div>
    <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
      {DOC_SLOTS.map(slot => {
        const done = created.has(slot.kind);
        return <button key={slot.kind} type="button" disabled={busy !== null} onClick={() => void run(slot.kind)}
          className="flex min-w-0 items-start gap-2 rounded-lg border border-border px-2.5 py-2 text-left transition-colors hover:bg-muted/40 disabled:opacity-60">
          {busy === slot.kind ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" /> : done ? <FileText className="mt-0.5 size-3.5 shrink-0 text-primary" /> : <FilePlus2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">{title(slot.kind)}</span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{done ? c.docOpen : hint(slot.kind)}</span>
          </span>
          <span className={done ? "shrink-0 text-[10px] text-primary" : "shrink-0 text-[10px] text-muted-foreground"}>{done ? c.docCreated : c.docPending}</span>
        </button>;
      })}
    </div>
    {error && <p role="alert" className="mt-1.5 text-[11px] text-destructive">{error}</p>}
  </section>;
}
