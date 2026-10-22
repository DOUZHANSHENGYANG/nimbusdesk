import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Download, MessageSquarePlus, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { pickBackupSavePath, writeBackup, inTauri } from "@/lib/tauri";
import { sessionTitle, toMarkdown, useSessions, type AgentSession } from "../sessions";
import { sessionForExport, useAgent } from "../store";

/** 时间：今天只显示时分，其余显示日期。 */
function shortTime(ms: number): string {
  const date = new Date(ms);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString();
}

/**
 * 会话菜单：新建 / 切换 / 重命名 / 删除 / 导出 / 清空。
 *
 * 用 Popover 而不是 DropdownMenu：里面要在原地改成输入框与两段式删除确认，
 * 而 DropdownMenu 每次点击都会关掉自己。
 */
export function SessionsMenu() {
  const { t } = useTranslation();
  const sessions = useSessions((state) => state.sessions);
  const currentId = useAgent((state) => state.sessionId);
  const status = useAgent((state) => state.status);
  const openSession = useAgent((state) => state.openSession);
  const newSession = useAgent((state) => state.newSession);
  const renameSession = useAgent((state) => state.renameSession);
  const removeSession = useAgent((state) => state.removeSession);
  const clearCurrent = useAgent((state) => state.clearCurrent);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const busy = status === "submitted" || status === "streaming";

  const ordered: AgentSession[] = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const untitled = t("agent.session.untitled");

  const exportMarkdown = async () => {
    const session = sessionForExport();
    if (!session) return;
    const markdown = toMarkdown(session, {
      user: t("agent.export.user"),
      assistant: t("agent.export.assistant"),
      tool: t("agent.export.tool"),
      attach: t("agent.export.attach"),
    });
    const name = `${sessionTitle(session, untitled).replace(/[\\/:*?"<>|]/g, "-")}.md`;
    if (!inTauri) {
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      return;
    }
    // 复用现有的两个 Rust 命令（选路径 + 原子写），不为导出新增命令。
    const path = await pickBackupSavePath(name);
    if (path) await writeBackup(path, markdown);
  };

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); setEditing(null); setConfirming(null); }}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          <MessageSquarePlus />
          {t("agent.session.title")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="agent-sessions">
        <div className="agent-sessions-head">
          <span className="agent-sessions-label">{t("agent.session.count", { count: sessions.length })}</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void newSession(); setOpen(false); }}>
            {t("agent.newChat")}
          </Button>
        </div>
        <div className="agent-sessions-list">
          {ordered.map((session) => (
            <div key={session.id} className="agent-session-row" data-active={session.id === currentId || undefined}>
              {editing === session.id ? (
                <input
                  autoFocus
                  className="agent-session-input"
                  value={draft}
                  placeholder={untitled}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") { renameSession(session.id, draft); setEditing(null); }
                    if (event.key === "Escape") setEditing(null);
                  }}
                />
              ) : confirming === session.id ? (
                <span className="agent-session-confirm">{t("agent.session.confirmDelete")}</span>
              ) : (
                <button
                  type="button"
                  className="agent-session-open"
                  onClick={() => { void openSession(session.id); setOpen(false); }}
                >
                  <span className="agent-session-name">{sessionTitle(session, untitled)}</span>
                  <span className="agent-session-time">{shortTime(session.updatedAt)}</span>
                </button>
              )}
              <div className="agent-session-tools">
                {editing === session.id ? (
                  <>
                    <Button size="icon" variant="ghost" aria-label={t("agent.session.save")} onClick={() => { renameSession(session.id, draft); setEditing(null); }}>
                      <Check />
                    </Button>
                    <Button size="icon" variant="ghost" aria-label={t("agent.cancel")} onClick={() => setEditing(null)}>
                      <X />
                    </Button>
                  </>
                ) : confirming === session.id ? (
                  <>
                    <Button size="icon" variant="ghost" aria-label={t("agent.session.delete")} onClick={() => { void removeSession(session.id); setConfirming(null); }}>
                      <Check />
                    </Button>
                    <Button size="icon" variant="ghost" aria-label={t("agent.cancel")} onClick={() => setConfirming(null)}>
                      <X />
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("agent.session.rename")}
                      onClick={() => { setEditing(session.id); setDraft(session.title ?? ""); }}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("agent.session.delete")}
                      onClick={() => setConfirming(session.id)}
                    >
                      <Trash2 />
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="agent-sessions-foot">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void exportMarkdown(); setOpen(false); }}>
            <Download />
            {t("agent.export.action")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={clearCurrent}>
            <Trash2 />
            {t("agent.session.clear")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
