import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/ahub/components/ui/button";
import { DiffView } from "@/ahub/components/VersionList";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ahub/components/ui/dialog";
import { api } from "@/ahub/lib/api";

export type ConflictStrategy = "keep-mine" | "use-remote" | "keep-both";

export interface UpstreamConflict {
  dirName: string;
  name: string;
  remote: string;
  mode: string;
  revision: string;
  repoPath: string;
  subtreeSha: string;
  candidatePath: string;
  tempDir: string;
  preview: {
    localModified: boolean | null;
    changed: string[];
    added: string[];
    removed: string[];
    localChanged: string[];
    skillMdLocal: string;
    skillMdRemote: string;
  };
}

/**
 * 本地被改过 + 上游也有变化时，别默默覆盖。
 * 这里只回答一个问题：这一份留谁的。文件列表点开就是逐行差异，让人看得见再决定。
 */
export function UpstreamConflictDialog({
  conflict,
  onResolve,
  onCancel,
}: {
  conflict: UpstreamConflict | null;
  onResolve: (strategy: ConflictStrategy) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [path, setPath] = useState("");
  const [diff, setDiff] = useState<{ path: string; local: string; remote: string; binary: boolean } | null>(null);
  const [loading, setLoading] = useState(false);

  const files = conflict
    ? [
        ...conflict.preview.changed.map((value) => ({ path: value, kind: "changed" as const })),
        ...conflict.preview.added.map((value) => ({ path: value, kind: "added" as const })),
        ...conflict.preview.removed.map((value) => ({ path: value, kind: "removed" as const })),
      ]
    : [];
  const edited = new Set(conflict?.preview.localChanged ?? []);

  // 打开时默认停在「你改过且上游也改了」的那个文件上，其次第一个差异文件
  useEffect(() => {
    if (!conflict) return;
    const preferred =
      files.find((file) => edited.has(file.path) && file.kind === "changed")?.path ??
      files[0]?.path ??
      "SKILL.md";
    setPath(preferred);
    // files/edited 每次渲染都是新数组，这里只跟着冲突本身重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflict?.dirName, conflict?.candidatePath]);

  useEffect(() => {
    if (!conflict || !path) return;
    let alive = true;
    setLoading(true);
    setDiff(null);
    void api
      .skillUpdateFileDiff(conflict.dirName, conflict.candidatePath, path)
      .then((result) => {
        if (alive) setDiff(result);
      })
      .catch(() => {
        if (alive) setDiff({ path, local: "", remote: "", binary: true });
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [conflict, path]);

  if (!conflict) return null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("skills.upConflictTitle", { name: conflict.name })}</DialogTitle>
          <DialogDescription>
            {conflict.preview.localModified === null ? t("skills.upConflictUnknown") : t("skills.upConflictModified")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="max-h-40 overflow-y-auto rounded-lg border border-border">
            {files.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-ink-3">{t("skills.upConflictNoFiles")}</p>
            ) : (
              files.map((file) => (
                <button
                  key={`${file.kind}:${file.path}`}
                  type="button"
                  aria-pressed={path === file.path}
                  onClick={() => setPath(file.path)}
                  className={
                    path === file.path
                      ? "flex w-full items-center gap-2 border-b border-border/60 bg-primary-soft/60 px-3 py-1.5 text-left last:border-0"
                      : "flex w-full items-center gap-2 border-b border-border/60 px-3 py-1.5 text-left last:border-0 hover:bg-muted/50"
                  }
                >
                  <span className="w-14 shrink-0 text-[10px] uppercase text-ink-3">{t(`skills.upDiff_${file.kind}`)}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">{file.path}</span>
                  {edited.has(file.path) ? (
                    <span className="shrink-0 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
                      {t("skills.upDiffYouEdited")}
                    </span>
                  ) : null}
                </button>
              ))
            )}
          </div>

          {loading ? (
            <div className="flex items-center gap-2 px-1 py-6 text-[12px] text-ink-3">
              <Loader2 className="size-3.5 animate-spin" />
              {t("skills.upDiffLoading")}
            </div>
          ) : diff?.binary ? (
            <p className="rounded-lg border border-border px-3 py-6 text-center text-[12px] text-ink-3">
              {t("skills.upDiffBinary")}
            </p>
          ) : diff ? (
            <DiffView
              from={diff.local}
              to={diff.remote}
              title={`${diff.path} · ${t("skills.upDiffLocal")} → ${t("skills.upDiffRemote")}`}
              height="max-h-72"
            />
          ) : null}
        </DialogBody>
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t("skills.upConflictLater")}
          </Button>
          <Button variant="secondary" onClick={() => onResolve("keep-mine")}>
            {t("skills.upKeepMine")}
          </Button>
          <Button variant="secondary" onClick={() => onResolve("keep-both")}>
            {t("skills.upKeepBoth")}
          </Button>
          <Button onClick={() => onResolve("use-remote")}>{t("skills.upUseRemote")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
