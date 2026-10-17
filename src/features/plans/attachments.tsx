import { useEffect, useRef, useState } from "react";
import { RiAttachment2, RiAddLine, RiFolderOpenLine, RiCloseLine, RiFileLine } from "@remixicon/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { addTaskAttachment, attachmentSize, openTaskAttachment, unlinkTaskAttachment } from "./attachment-api";
import { usePlanCopy } from "./copy";
import type { PlanTask, TaskAttachment } from "./types";
import "./tasks-attachments.css";

/** Shared by the outline and desktop day window; it has no modal/toast provider dependency. */
export function TaskAttachments({ date, task, compact = false, inline = false }: { date: string; task: PlanTask; compact?: boolean; inline?: boolean }) {
  const copy = usePlanCopy();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const attachments = task.attachments ?? [];

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const open = async (attachment: TaskAttachment, reveal = false) => {
    setError("");
    try { await openTaskAttachment(attachment, reveal); }
    catch (cause) { if (mounted.current) setError(`${copy.attachmentFailed}: ${String(cause)}`); }
  };
  const upload = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try { if (!await addTaskAttachment(date, task.id) && mounted.current) setError(copy.taskMissing); }
    catch (cause) { if (mounted.current) setError(`${copy.attachmentFailed}: ${String(cause)}`); }
    finally { if (mounted.current) setBusy(false); }
  };
  const content = <>
        <div className="task-attachments-header">
          <span>{copy.attachments}{attachments.length > 0 ? ` · ${attachments.length}` : ""}</span>
          <button type="button" className="task-attachments-add" disabled={busy} title={copy.localFiles} onClick={() => void upload()}>
            <RiAddLine size={14} />{busy ? copy.addingAttachment : copy.addAttachment}
          </button>
        </div>
        {attachments.length === 0 && <p className="task-attachments-empty">{copy.noAttachments}</p>}
        {attachments.map((attachment) => (
          <div className="task-attachment" key={attachment.id}>
            <RiFileLine size={14} className="task-attachment-icon" />
            <button type="button" className="task-attachment-name" title={`${copy.open}: ${attachment.name}`}
              onClick={() => void open(attachment)}>
              <span>{attachment.name}</span><small>{attachmentSize(attachment.size)}</small>
            </button>
            <button type="button" className="task-attachment-action" title={copy.reveal} aria-label={`${copy.reveal}: ${attachment.name}`}
              onClick={() => void open(attachment, true)}><RiFolderOpenLine size={14} /></button>
            <button type="button" className="task-attachment-action" title={copy.unlinkHint} aria-label={`${copy.unlink}: ${attachment.name}`}
              onClick={() => unlinkTaskAttachment(date, task.id, attachment.id)}><RiCloseLine size={14} /></button>
          </div>
        ))}
        {error && <p role="alert" className="task-attachments-error">{error}</p>}
  </>;
  if (inline) return <div className="task-attachments-panel task-attachments-inline" aria-label={`${copy.attachments}: ${task.title}`}>{content}</div>;
  return <Popover open={expanded} onOpenChange={setExpanded}>
    <div className={`task-attachments${compact ? " task-attachments--compact" : ""}`}>
      <PopoverTrigger asChild><button type="button" className="task-attachments-toggle"
        title={`${copy.attachments}${attachments.length ? ` · ${attachments.length}` : ""}`} aria-label={`${copy.attachments}: ${task.title}`}>
        <RiAttachment2 size={compact ? 13 : 14}/>{attachments.length > 0 && <span className="task-attachments-count">{attachments.length}</span>}
      </button></PopoverTrigger>
    </div>
    <PopoverContent align="end" sideOffset={7} collisionPadding={12} aria-label={`${copy.attachments}: ${task.title}`} className="workbench-ui task-attachments-panel">{content}</PopoverContent>
  </Popover>;
}
