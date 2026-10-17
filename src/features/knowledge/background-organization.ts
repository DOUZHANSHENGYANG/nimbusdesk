import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { inTauri } from '@/lib/tauri';
import { flushAllStorage } from '@/lib/storage';
import { providersReady, useProviders } from '@/features/ai/providers';
import { selectProvider } from '@/features/ai/core';
import { scanNotes, listCaptures, readNote, organizeNotes } from './api';
import { automaticCandidates, normalizeOrganizationPreferences, runAutomaticOrganization } from './auto-organize';
import { createOrganizationCoordinator, dueOrganizationSchedule, type OrganizationRequest } from './background-organization-core';
import { loadNoteDraft } from './drafts';
import { vaultKey } from './folders';
import { loadOrganizationMaterials } from './organization-materials';
import { suggestOrganization } from './organize';
import { useOrganizationJobs } from './organization-jobs';
import { getKnowledgeFolders, useKnowledge } from './store';

const structures={
  auto:'根据材料选择开发经验、开发配方或资源收藏。保留事实、代码、来源与图片引用，生成清晰结构和 2–6 个主题标签。',
  experience:'## 背景与环境\n## 问题与现象\n## 原因分析\n## 解决步骤\n## 验证结果\n## 注意事项与参考资料',
  recipe:'## 适用场景\n## 前置条件\n## 参数（使用 {{参数名}}）\n## 操作步骤与命令\n## 验证方法\n## 失败处理',
  resource:'## 来源\n## 适用场景\n## 核心要点\n## 使用方法\n## 局限与相关资料',
};
const REQUEST_EVENT='knowledge:organization-request';
const ACK_EVENT='knowledge:organization-ack';
const STOP_EVENT='knowledge:organization-stop';
const TICK_EVENT='knowledge:organization-tick';
const COMPLETED_EVENT='knowledge:organization-completed';
const dirtyPaths=new Set<string>();
const pathKey=(root:string,path:string)=>`${vaultKey(root)}:${path.replace(/\\/g,'/').toLowerCase()}`;
export function setOrganizationBlockedPath(root:string,path:string,blocked:boolean):void {
  const key=pathKey(root,path);if(blocked)dirtyPaths.add(key);else dirtyPaths.delete(key);
}
function mainWindow(){return !inTauri || getCurrentWindow().label==='main';}

function hydrated(store:{persist:{hasHydrated:()=>boolean;onFinishHydration:(fn:()=>void)=>()=>void}}):Promise<void> {
  if(store.persist.hasHydrated())return Promise.resolve();
  return new Promise(resolve=>{const off=store.persist.onFinishHydration(()=>{off();resolve();});if(store.persist.hasHydrated()){off();resolve();}});
}
async function ready(){await Promise.all([hydrated(useKnowledge),hydrated(useOrganizationJobs),providersReady()]);}
async function assertSaved(root:string,path:string,blocked:string[]){
  if(dirtyPaths.has(pathKey(root,path)) || blocked.some(item=>pathKey(root,item)===pathKey(root,path)))throw new Error('笔记有未保存的编辑，已跳过；保存后可再次整理。');
  const draft=await loadNoteDraft(root,path);
  if(draft && draft.content!==draft.base.content)throw new Error('笔记有未保存的草稿，已跳过；保存后可再次整理。');
  // The draft read is asynchronous. Check again for edits typed while it was reading.
  if(dirtyPaths.has(pathKey(root,path)))throw new Error('笔记有未保存的编辑，已跳过；保存后可再次整理。');
}
const coordinator=createOrganizationCoordinator({
  ready,readJob:()=>useOrganizationJobs.getState().job,
  writeJob:job=>useOrganizationJobs.getState().setJob(job),flush:flushAllStorage,
  execute:async(request,control)=>{
    // Capture all mutable preferences before the first asynchronous operation.
    const prefs=normalizeOrganizationPreferences(useKnowledge.getState().organization);
    const folders={...getKnowledgeFolders(request.root)};
    const blocked=[...(request.blockedPaths ?? [])];
    const selected=request.paths ? new Set(request.paths) : null;
    if(control.shouldStop())return {completed:[],failed:[],cancelled:true};
    try{selectProvider(useProviders.getState(),false);}catch{throw new Error('请先在「设置 → AI」选择默认模型提供商，再启动整理。');}
    const [notes,captures]=await Promise.all([scanNotes(request.root,folders),listCaptures(request.root)]);
    const candidates=automaticCandidates(notes,captures,prefs).filter(note=>!selected || selected.has(note.path));
    control.progress({processed:0,total:candidates.length,title:''});
    return runAutomaticOrganization(candidates,prefs,{
      load:async note=>{await assertSaved(request.root,note.path,blocked);return loadOrganizationMaterials(notes,captures,[note.path],path=>readNote(request.root,path));},
      suggest:(materials,preferences)=>suggestOrganization(request.root,materials,preferences.sendImages && materials.some(item=>item.capture.attachments.length>0),{
        template:`${structures[preferences.template]}\n\n用户整理偏好：\n${preferences.instructions || '保留所有有用内容，不编造事实；不合并无关文章。'}`,
        kind:preferences.template==='auto'?undefined:preferences.template,
      }),
      save:async(materials,suggestion)=>{
        const progress=useOrganizationJobs.getState().job?.progress;
        if(progress && materials[0])control.progress({...progress,phase:'saving',path:materials[0].note.path});
        // Publish the short write lease to every window before beginning the native move.
        // An editor racing with publication is detected by the second draft check below.
        await flushAllStorage();
        for(const material of materials)await assertSaved(request.root,material.note.path,blocked);
        if(control.shouldStop())throw new Error('整理已停止，未写入当前文章。');
        return organizeNotes(request.root,{...suggestion,sources:materials.map(item=>({path:item.note.path,fingerprint:item.note.fingerprint}))},folders);
      },
      shouldStop:control.shouldStop,onProgress:control.progress,
    });
  },
  completed:async job=>{
    const detail={root:job.root,jobId:job.id};
    window.dispatchEvent(new CustomEvent(COMPLETED_EVENT,{detail}));
    if(inTauri)await emit(COMPLETED_EVENT,detail);
  },
});

interface JobRequest extends OrganizationRequest { requestId:string; replyTo:string }
interface JobAck { requestId:string; jobId?:string; error?:string }
async function requestMain(request:OrganizationRequest):Promise<string> {
  const requestId=crypto.randomUUID(),replyTo=getCurrentWindow().label;
  let off:(()=>void)|undefined;
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try {
    return await new Promise<string>((resolve,reject)=>{
      void listen<JobAck>(ACK_EVENT,({payload})=>{
        if(payload.requestId!==requestId)return;
        if(payload.jobId)resolve(payload.jobId);else reject(new Error(payload.error || '整理任务未能启动。'));
      }).then(unlisten=>{
        off=unlisten;
        timeout=setTimeout(()=>reject(new Error('主窗口未响应；素材已保存到收件箱，可稍后重新整理。')),15000);
        return emitTo('main',REQUEST_EVENT,{...request,requestId,replyTo});
      }).catch(reject);
    });
  } finally {off?.();if(timeout)clearTimeout(timeout);}
}
/** Returns after durable acceptance; work continues after page changes or capture dismissal. */
export async function startOrganization(request:OrganizationRequest):Promise<string> {
  if(!mainWindow())return requestMain(request);
  try{return await coordinator.start(request);}catch(error){
    const message=error instanceof Error?error.message:String(error);
    if(message==='ORGANIZATION_BUSY')throw new Error('已有整理任务正在进行，可在进度面板查看或停止。');
    if(message==='ORGANIZATION_NO_VAULT')throw new Error('请先在设置中绑定 Obsidian 知识库。');
    throw error;
  }
}
export async function stopOrganization():Promise<void> {
  if(!mainWindow()){await emitTo('main',STOP_EVENT,{});return;}
  await coordinator.stop();
}

let runtimeUsers=0;
let runtimeDispose:(()=>void)|undefined;
let checkingSchedule=false;
async function checkSchedule(){
  if(checkingSchedule)return;
  checkingSchedule=true;
  try {
    await ready();
    const {vaultRoot,organization}=useKnowledge.getState();
    if(!vaultRoot || coordinator.busy())return;
    const claim=dueOrganizationSchedule(new Date(),vaultRoot,normalizeOrganizationPreferences(organization).schedule,useOrganizationJobs.getState().receipts);
    if(!claim)return;
    useOrganizationJobs.getState().claim(vaultKey(vaultRoot),claim);
    // start reserves single-flight synchronously and persists this claim with acceptance before AI.
    // A separate await here would allow a manual submission to steal the slot after claiming the day.
    await coordinator.start({root:vaultRoot,trigger:'schedule'});
  } catch { /* Storage/provider failures are exposed by the job or shared storage health. No retry loop. */ }
  finally{checkingSchedule=false;}
}
/** Exactly one coordinator in the main WebView. Cleanup removes watchers, never cancels accepted work. */
export function startOrganizationRuntime():()=>void {
  if(!mainWindow())return ()=>undefined;
  runtimeUsers++;
  if(!runtimeDispose){
    let disposed=false;
    const cleanups:(()=>void)[]=[];
    const watch=<T,>(event:string,handler:(payload:T)=>void)=>{
      void listen<T>(event,({payload})=>handler(payload)).then(off=>{if(disposed)off();else cleanups.push(off);}).catch(()=>undefined);
    };
    if(inTauri){
      watch<JobRequest>(REQUEST_EVENT,request=>{
        if(!request || typeof request.requestId!=='string' || typeof request.replyTo!=='string' || typeof request.root!=='string')return;
        void startOrganization({root:request.root,paths:request.paths,blockedPaths:request.blockedPaths,trigger:request.trigger}).then(jobId=>emitTo(request.replyTo,ACK_EVENT,{requestId:request.requestId,jobId}),error=>emitTo(request.replyTo,ACK_EVENT,{requestId:request.requestId,error:error instanceof Error?error.message:String(error)})).catch(()=>undefined);
      });
      watch(TICK_EVENT,()=>{void checkSchedule();});
      watch(STOP_EVENT,()=>{void coordinator.stop().catch(()=>undefined);});
    }
    const wake=()=>{void checkSchedule();};
    window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);
    cleanups.push(()=>window.removeEventListener('focus',wake),()=>document.removeEventListener('visibilitychange',wake));
    // Browser fallback and native watchdog; the Rust tick remains active when WebView timers throttle.
    const interval=setInterval(wake,20000);cleanups.push(()=>clearInterval(interval));
    cleanups.push(useKnowledge.subscribe((state,previous)=>{
      if(state.vaultRoot!==previous.vaultRoot || state.organization!==previous.organization)wake();
    }));
    void coordinator.recover().then(()=>{if(!disposed)wake();}).catch(()=>undefined);
    runtimeDispose=()=>{disposed=true;for(const cleanup of cleanups)cleanup();};
  }
  return ()=>{runtimeUsers--;if(runtimeUsers===0){runtimeDispose?.();runtimeDispose=undefined;}};
}
