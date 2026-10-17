import { useId, useState } from 'react';
import { AlertCircle, Check, ChevronDown, LoaderCircle, Sparkles, Square, X } from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useSettings } from '@/stores/settings';
import { useOrganizationJobs } from './organization-jobs';
import { stopOrganization } from './background-organization';
import './organization-activity.css';

/** Application-level progress. Opening or closing details never starts or stops work. */
export function OrganizationActivity({ compact = false }: { compact?: boolean }) {
  const en = useSettings(s => s.lang) === 'en';
  const job = useOrganizationJobs(s => s.job);
  const dismiss = useOrganizationJobs(s => s.dismiss);
  const [open, setOpen] = useState(false);
  const headingId = useId();
  if (!job) return null;
  const active = job.status === 'running' || job.status === 'stopping';
  const stopping = job.status === 'stopping';
  const { processed, total, title } = job.progress;
  const completed = job.result?.completed ?? [];
  const failed = job.result?.failed ?? [];
  const status = job.status === 'running' ? (en ? 'Organizing in background' : '正在后台整理')
    : stopping ? (en ? 'Stopping after current request' : '正在停止整理')
    : job.status === 'interrupted' ? (en ? 'Organization interrupted' : '整理已中断')
    : job.status === 'cancelled' ? (en ? 'Organization stopped' : '整理已停止')
    : job.status === 'failed' ? (en ? 'Organization failed' : '整理失败')
    : failed.length ? (en ? 'Organization finished with errors' : '整理结束，部分失败')
    : (en ? 'Organization complete' : '整理完成');
  const Icon = active ? LoaderCircle : job.status === 'completed' && !failed.length ? Check : AlertCircle;
  const count = total ? `${processed} / ${total}` : active ? (en ? 'Preparing…' : '准备中…') : '0 / 0';
  const trigger = job.trigger === 'schedule' ? (en ? 'Scheduled' : '定时任务')
    : job.trigger === 'capture' ? (en ? 'Quick capture' : '快捷收集') : (en ? 'Started manually' : '手动启动');
  async function stop() {
    try { await stopOrganization(); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
  }
  return <div className={`organization-activity${compact ? ' organization-activity-compact' : ''}`} data-status={job.status}>
    <Popover modal={false} open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="organization-activity-trigger" aria-label={`${en ? 'Organization progress' : '查看整理进度'} · ${status} · ${count}`}>
          <Icon className={active ? 'organization-activity-spinner' : ''} aria-hidden="true"/>
          <span className="organization-activity-status" role="status">{status}</span>
          <span className="organization-activity-count">{count}</span>
          {active && total > 0 && <span className="organization-activity-track" aria-hidden="true"><span style={{width:`${Math.min(100, processed / total * 100)}%`}}/></span>}
          <ChevronDown className="organization-activity-chevron" aria-hidden="true"/>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="organization-activity-details" aria-labelledby={headingId}>
        <header>
          <div><h2 id={headingId}><Sparkles aria-hidden="true"/>{en ? 'AI organization' : 'AI 整理进度'}</h2><p>{job.root.split(/[\\/]/).filter(Boolean).pop()} · {trigger} · {new Date(job.startedAt).toLocaleTimeString(en ? 'en-US' : 'zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}</p></div>
          <button type="button" className="organization-activity-icon-button" aria-label={en ? 'Close progress details' : '关闭进度详情'} onClick={()=>setOpen(false)}><X aria-hidden="true"/></button>
        </header>
        <div className="organization-activity-detail-status"><span>{status}</span><strong>{count}</strong></div>
        <div className="organization-activity-detail-track" role="progressbar" aria-label={en ? 'Organization progress' : '整理进度'} aria-valuemin={0} aria-valuemax={Math.max(total,1)} aria-valuenow={processed} aria-valuetext={count}>
          <span style={{width:`${total ? Math.min(100,processed / total * 100) : 0}%`}}/>
        </div>
        {active && title && <p className="organization-activity-current">{en ? 'Current article' : '当前文章'}<strong>{title}</strong></p>}
        {job.error && <p className="organization-activity-error" role="alert">{job.error}</p>}
        {(completed.length > 0 || failed.length > 0) && <div className="organization-activity-results">
          <p>{en ? `${completed.length} organized · ${failed.length} failed` : `已归档 ${completed.length} 篇 · 失败 ${failed.length} 篇`}</p>
          {completed.length > 0 && <details><summary>{en ? 'Organized articles' : '已整理文章'}</summary><ul>{completed.map(note=><li key={note.path}><Check aria-hidden="true"/><span>{note.title}</span></li>)}</ul></details>}
          {failed.length > 0 && <details open><summary>{en ? 'Failure details' : '失败详情'}</summary><ul>{failed.map(note=><li key={note.path}><AlertCircle aria-hidden="true"/><span>{note.path}<small>{note.error}</small></span></li>)}</ul></details>}
        </div>}
        <footer>
          <p>{active ? stopping ? (en ? 'Waiting for the current request; pending changes will not be saved.' : '等待当前请求结束，尚未归档的结果不会写入。') : (en ? 'Continue working or switch pages. Progress stays here.' : '可继续操作、切换页面，整理会在后台继续。') : job.status === 'interrupted' ? (en ? 'The app exited before completion. Start again to continue pending notes.' : '上次运行在应用退出时中断，可重新启动以处理剩余笔记。') : (en ? 'Closing this status does not change organized files.' : '收起状态不会更改已整理的文件。')}</p>
          {active ? <button type="button" className="organization-activity-action" disabled={stopping} onClick={()=>void stop()}><Square aria-hidden="true"/>{en ? 'Stop organization' : '停止整理'}</button> : <button type="button" className="organization-activity-action" onClick={()=>{setOpen(false);dismiss();}}>{en ? 'Dismiss' : '收起进度'}</button>}
        </footer>
      </PopoverContent>
    </Popover>
    {!active && <button type="button" className="organization-activity-icon-button" aria-label={en ? 'Dismiss organization status' : '收起整理状态'} onClick={()=>{setOpen(false);dismiss();}}><X aria-hidden="true"/></button>}
  </div>;
}
