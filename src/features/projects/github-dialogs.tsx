/** 两个仓库级动作：下载源码包到指定文件夹、关联本地项目。都只动本机。 */
import { useEffect, useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useProjects } from "./store";
import { useGithub } from "./github-store";
import { defaultDownloadDir, downloadRepoZip } from "./github-api";
import { cn } from "@/lib/utils";
import type { GithubCopy } from "./github-copy";
import type { GithubRepo } from "./github-types";

export function GithubDownloadDialog({ repo, copy, onClose }: { repo: GithubRepo; copy: GithubCopy; onClose: () => void }) {
  const configured = useGithub(s => s.downloadDir);
  const setDownloadDir = useGithub(s => s.setDownloadDir);
  const [system, setSystem] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(configured);
  const [picked, setPicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => { void defaultDownloadDir().then(setSystem).catch(() => setSystem(null)); }, []);
  const target = folder ?? system;

  async function pick() {
    try {
      const chosen = await openFolderDialog({ directory: true, multiple: false, defaultPath: target ?? undefined });
      if (typeof chosen === "string") { setFolder(chosen); setPicked(true); }
    } catch {
      // 取消或没有权限：保持原目录
    }
  }

  async function run() {
    if (!target || busy) return;
    setBusy(true); setFailed(false); setSaved(null);
    try {
      const result = await downloadRepoZip(repo, target);
      setSaved(result.path);
      // 只记用户亲手选过的目录；系统默认目录下次还要重新解析，Windows 改过就跟着改。
      if (picked) setDownloadDir(target);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
      <DialogHeader><DialogTitle>{copy.downloadTitle}</DialogTitle></DialogHeader>
      <div>
        <p className="truncate text-sm font-medium">{repo.fullName}</p>
        <p className="mt-2 text-[11px] text-muted-foreground">{copy.downloadFolder}</p>
        <p className="mt-0.5 truncate rounded bg-muted/60 px-2 py-1 font-mono text-[11px]" title={target ?? ""}>{target ?? copy.loading}</p>
        {saved && <p className="mt-2 break-all text-[11px] text-muted-foreground">{copy.downloaded} <span className="font-mono">{saved}</span></p>}
        {failed && <p role="alert" className="mt-2 text-[11px] text-destructive">{copy.downloadFailed}</p>}
      </div>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={() => void pick()}><FolderOpen />{copy.chooseFolder}</Button>
        <Button variant="secondary" size="sm" onClick={onClose}>{copy.close}</Button>
        <Button size="sm" disabled={!target || busy} onClick={() => void run()}>{busy ? <><LoaderCircle className="animate-spin motion-reduce:animate-none" />{copy.downloading}</> : copy.download}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function GithubLinkDialog({ repo, copy, onClose, onOpenProject }: { repo: GithubRepo; copy: GithubCopy; onClose: () => void; onOpenProject?: (projectId: string) => void }) {
  const projects = useProjects(s => s.projects);
  const links = useGithub(s => s.links);
  const link = useGithub(s => s.link);
  const unlink = useGithub(s => s.unlink);
  const unlinkRepo = useGithub(s => s.unlinkRepo);
  const linked = links.filter(item => item.fullName === repo.fullName);
  const linkedIds = new Set(linked.map(item => item.projectId));
  const active = projects.filter(project => project.status !== "archived");

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
      <DialogHeader><DialogTitle>{copy.linkTitle}</DialogTitle></DialogHeader>
      <div>
        <p className="truncate text-sm font-medium">{repo.fullName}</p>
        {linked.length > 0 && <p className="mt-1 text-[11px] text-muted-foreground">{copy.linkedTo} {linked.map(item => projects.find(project => project.id === item.projectId)?.name ?? "—").join(copy.listSeparator)}</p>}
        <div className="mt-2 max-h-56 overflow-y-auto" role="list">
          {!active.length ? <p className="p-2 text-[11px] text-muted-foreground">{copy.noProjects}</p>
            : active.map(project => <div key={project.id} role="listitem" className="flex items-center gap-1">
              <button type="button" onClick={() => { if (linkedIds.has(project.id)) unlink(project.id, repo.fullName); else link(project.id, repo.fullName); }}
                aria-pressed={linkedIds.has(project.id)}
                className={cn("flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-[13px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring", linkedIds.has(project.id) && "bg-accent text-accent-foreground")}>
                <span className="truncate">{project.name}</span>
              </button>
              {linkedIds.has(project.id) && onOpenProject && <Button variant="ghost" size="icon-xs" title={copy.linkedJump} aria-label={copy.linkedJump} onClick={() => onOpenProject(project.id)}>↗</Button>}
            </div>)}
        </div>
      </div>
      <DialogFooter>
        {linked.length > 0 && <Button variant="ghost" size="sm" onClick={() => { unlinkRepo(repo.fullName); onClose(); }}>{copy.unlink}</Button>}
        <Button variant="secondary" size="sm" onClick={onClose}>{copy.close}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
