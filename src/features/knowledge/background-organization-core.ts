import type { OrganizationProgress, OrganizationResult } from './auto-organize';
import type { OrganizationPreferences } from './auto-organize';
import { vaultKey } from './folders.ts';

export type OrganizationTrigger = 'manual' | 'capture' | 'schedule';
export interface OrganizationRequest { root:string; paths?:string[]; blockedPaths?:string[]; trigger?:OrganizationTrigger }
export interface OrganizationJob {
  id:string; root:string; status:'running'|'stopping'|'completed'|'failed'|'cancelled'|'interrupted';
  trigger:OrganizationTrigger; startedAt:number; finishedAt?:number;
  progress:OrganizationProgress; result?:OrganizationResult; error?:string;
}
export interface ScheduleReceipt { day:string; time:string; claimedAt:number }
export type ScheduleReceipts = Record<string,ScheduleReceipt>;
export const organizationBusy = (job:OrganizationJob|null) => job?.status === 'running' || job?.status === 'stopping';
/** Editing stays available during AI generation and pauses only for the final source transaction. */
export function organizationWritesNote(job:OrganizationJob|null,root:string,path:string):boolean {
  const normalizePath=(value:string)=>value.replace(/\\/g,'/').toLowerCase();
  return !!job && organizationBusy(job) && job.progress.phase==='saving'
    && vaultKey(job.root)===vaultKey(root) && !!job.progress.path && normalizePath(job.progress.path)===normalizePath(path);
}

/** Store only job metadata, never article text or YAML in the shared SQLite state. */
export function metadataResult(result:OrganizationResult):OrganizationResult {
  return {completed:result.completed.map(note=>({path:note.path,title:note.title,kind:note.kind,modifiedAt:note.modifiedAt,preview:'',organized:note.organized})),
    failed:result.failed.map(item=>({path:item.path,error:item.error.slice(0,1000)})),cancelled:result.cancelled};
}
export function interruptedJob(job:OrganizationJob|null, now:number):OrganizationJob|null {
  return organizationBusy(job) ? {...job!,status:'interrupted',finishedAt:now,error:'应用已退出，上次整理已中断；已完成的文章已保留。'} : job;
}
export function dueOrganizationSchedule(now:Date,root:string,schedule:OrganizationPreferences['schedule'],receipts:ScheduleReceipts):ScheduleReceipt|null {
  if(!schedule.enabled || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time))return null;
  const [hour,minute]=schedule.time.split(':').map(Number);
  if(now.getHours()*60+now.getMinutes()<hour*60+minute)return null;
  const day=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  if(receipts[vaultKey(root)]?.day===day)return null;
  return {day,time:schedule.time,claimedAt:now.getTime()};
}

/** A single owner, independent of component lifetime. Acceptance is durable before execution. */
export function createOrganizationCoordinator(deps:{
  ready:()=>Promise<void>; readJob:()=>OrganizationJob|null; writeJob:(job:OrganizationJob)=>void; flush:()=>Promise<void>;
  execute:(request:OrganizationRequest,control:{shouldStop:()=>boolean;progress:(value:OrganizationProgress)=>void})=>Promise<OrganizationResult>;
  completed?:(job:OrganizationJob)=>void|Promise<void>; id?:()=>string; now?:()=>number;
}) {
  const now=deps.now ?? Date.now;
  let active:{stopped:boolean;id:string}|null=null;
  function patch(id:string,value:Partial<OrganizationJob>){const job=deps.readJob();if(job?.id===id)deps.writeJob({...job,...value});}
  async function finish(request:OrganizationRequest,token:{stopped:boolean;id:string}) {
    try {
      const result=metadataResult(await deps.execute(request,{shouldStop:()=>token.stopped,progress:value=>patch(token.id,{progress:value})}));
      patch(token.id,{result,status:result.cancelled?'cancelled':'completed',finishedAt:now()});
      await deps.flush();
    } catch(error) {
      patch(token.id,{status:token.stopped?'cancelled':'failed',error:error instanceof Error?error.message.slice(0,1000):String(error).slice(0,1000),finishedAt:now()});
      await deps.flush().catch(()=>undefined);
    } finally {
      if(active===token)active=null;
      const job=deps.readJob();
      if(job?.id===token.id)await Promise.resolve().then(()=>deps.completed?.(job)).catch(()=>undefined);
    }
  }
  return {
    busy:()=>active!==null,
    async start(request:OrganizationRequest):Promise<string> {
      if(active)throw new Error('ORGANIZATION_BUSY');
      const token={stopped:false,id:deps.id?.() ?? crypto.randomUUID()};active=token;
      try {
        await deps.ready();
        if(!request.root.trim())throw new Error('ORGANIZATION_NO_VAULT');
        deps.writeJob({id:token.id,root:request.root,status:token.stopped?'stopping':'running',trigger:request.trigger ?? 'manual',startedAt:now(),progress:{processed:0,total:0,title:''}});
        await deps.flush();
      } catch(error) {
        patch(token.id,{status:'failed',error:error instanceof Error?error.message:String(error),finishedAt:now()});
        active=null;throw error;
      }
      // Never await the AI run here: callers may navigate away or clear a saved capture.
      void finish(request,token);
      return token.id;
    },
    async stop():Promise<void> {
      if(!active)return;
      active.stopped=true;patch(active.id,{status:'stopping'});await deps.flush();
    },
    async recover():Promise<void> {
      await deps.ready();
      if(active)return;
      const job=deps.readJob(),next=interruptedJob(job,now());
      if(next && next!==job){deps.writeJob(next);await deps.flush();}
    },
  };
}
