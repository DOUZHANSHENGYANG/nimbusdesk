import { useCallback, useEffect, useState } from "react";
import { FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { pickFolder, revealInExplorer } from "@/lib/tauri";
import { useLocalRepos } from "@/stores/local-repos";
import { gitRepoStatus, type GitRepoError, type GitRepoStatus } from "./api";
import { useGithubCopy } from "./github-copy";

/**
 * 本机 git 仓库（GitHub 面板里的一段）：登记路径 + 读状态，**不写仓库**。
 *
 * 与项目无关：仓库在磁盘上，不属于哪个项目；挂到项目下会让「换个项目管理同一份代码」
 * 变成一道无意义的二选一。要提交/推送仍在 git 自己那儿做 —— 这里没有能弄坏仓库的操作。
 */
export function LocalRepos() {
  const c = useGithubCopy();
  const repos = useLocalRepos((state) => state.repos);
  const add = useLocalRepos((state) => state.add);
  const remove = useLocalRepos((state) => state.remove);
  /** path → 状态；读失败时是 GitRepoError */
  const [statuses, setStatuses] = useState<Record<string, GitRepoStatus | GitRepoError>>({});
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");

  const read = useCallback(async () => {
    setReading(true);
    setError("");
    try {
      const entries = await Promise.all(repos.map(async (path) => {
        try {
          return [path, await gitRepoStatus(path)] as const;
        } catch (cause) {
          // Tauri 把 Err 序列化成结构化对象 { kind, message }；不是字符串，别按字符串去找
          return [path, toError(cause)] as const;
        }
      }));
      setStatuses(Object.fromEntries(entries));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setReading(false);
    }
  }, [repos.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void read(); }, [read]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <p className="text-[11px] leading-4 text-muted-foreground">{c.reposHint}</p>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="ghost" disabled={reading || !repos.length} onClick={() => void read()}>
            <RefreshCw className={reading ? "animate-spin motion-reduce:animate-none" : undefined} />{c.reposRefresh}
          </Button>
          <Button size="sm" onClick={() => void pickFolder().then((dir) => { if (dir) add(dir); }).catch((cause) => setError(String(cause)))}>
            {c.reposAdd}
          </Button>
        </div>
      </div>

      {error && <p role="alert" className="border-b border-border px-3 py-2 text-xs text-destructive">{error}</p>}

      <div className="min-h-0 flex-1 overflow-auto">
        {!repos.length ? (
          <div className="flex min-h-[160px] flex-col items-center justify-center gap-3 p-8 text-center text-xs text-muted-foreground">
            <p>{c.reposEmpty}</p>
            <Button size="sm" variant="outline" onClick={() => void pickFolder().then((dir) => { if (dir) add(dir); }).catch((cause) => setError(String(cause)))}>{c.reposAdd}</Button>
          </div>
        ) : repos.map((path) => {
          const status = statuses[path];
          return (
            <div key={path} className="flex min-w-0 items-center gap-3 border-b border-border/60 px-3 py-2 last:border-0">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-foreground/90" title={path}>{path}</p>
                <p className="truncate text-[11px] leading-4 text-muted-foreground">{status ? describe(status, c) : c.reposReading}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button size="sm" variant="ghost" title={path} onClick={() => void revealInExplorer(path).catch((cause) => setError(String(cause)))}>
                  <FolderOpen />{c.reposOpen}
                </Button>
                <Button size="sm" variant="ghost" aria-label={`${c.reposRemove} ${path}`} onClick={() => remove(path)}>
                  <Trash2 />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 归一错误：Rust 侧回的是 `{ kind, message }`；认不出的种类落到 failed，原文留着便于排查。 */
function toError(cause: unknown): GitRepoError {
  const value = cause as { kind?: unknown; message?: unknown } | null;
  const kind = typeof value?.kind === "string" ? value.kind : "";
  const known: GitRepoError["kind"][] = ["notFound", "noGit", "notRepo"];
  return {
    kind: known.includes(kind as GitRepoError["kind"]) ? (kind as GitRepoError["kind"]) : "failed",
    message: typeof value?.message === "string" ? value.message : String(cause),
  };
}

/** 状态一行话：分支 + 未提交 + 最近提交 */
function describe(status: GitRepoStatus | GitRepoError, c: ReturnType<typeof useGithubCopy>): string {
  if ("kind" in status) {
    return status.kind === "notRepo" ? c.reposNotRepo
      : status.kind === "noGit" ? c.reposNoGit
      : status.kind === "notFound" ? c.reposNotFound
      : status.message;
  }
  const dirty = status.dirty ? c.reposDirty.replace("{{count}}", String(status.changed)) : c.reposClean;
  const commit = status.commit ? `${status.commit.short} · ${status.commit.subject}` : c.reposNoCommit;
  return `${status.branch} · ${dirty} · ${commit}`;
}
