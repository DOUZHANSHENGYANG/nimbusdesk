import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { onStorageSynced, tauriJsonStorage } from '@/lib/storage';
import { metadataResult, organizationBusy, type OrganizationJob, type ScheduleReceipts } from './background-organization-core';
export type { OrganizationJob } from './background-organization-core';

interface OrganizationJobs {
  job:OrganizationJob|null;
  receipts:ScheduleReceipts;
  setJob:(job:OrganizationJob)=>void;
  claim:(key:string,value:ScheduleReceipts[string])=>void;
  dismiss:()=>void;
}
function cleanJob(value:unknown):OrganizationJob|null {
  if(!value || typeof value!=='object')return null;
  const job=value as OrganizationJob;
  if(typeof job.id!=='string' || typeof job.root!=='string' || !['running','stopping','completed','failed','cancelled','interrupted'].includes(job.status)
    || !job.progress || !Number.isFinite(job.progress.processed) || !Number.isFinite(job.progress.total) || typeof job.progress.title!=='string')return null;
  try{return {...job,...(job.result?{result:metadataResult(job.result)}:{})};}catch{return null;}
}
function cleanReceipts(value:unknown):ScheduleReceipts {
  const receipts:ScheduleReceipts={};
  if(value && typeof value==='object')for(const [key,raw] of Object.entries(value).slice(0,1000)){
    const receipt=raw as ScheduleReceipts[string];
    if(receipt && /^\d{4}-\d{2}-\d{2}$/.test(receipt.day) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(receipt.time) && Number.isFinite(receipt.claimedAt))receipts[key]=receipt;
  }
  return receipts;
}
export const useOrganizationJobs=create<OrganizationJobs>()(persist((set)=>({
  job:null,receipts:{},
  setJob:job=>set({job:cleanJob(job)}),
  claim:(key,value)=>set(state=>({receipts:{...state.receipts,[key]:value}})),
  dismiss:()=>set(state=>organizationBusy(state.job)?{}:{job:null}),
}),{
  name:'knowledge-organization-jobs',version:1,storage:createJSONStorage(()=>tauriJsonStorage),
  partialize:state=>({job:state.job,receipts:state.receipts}),
  merge:(persisted,current)=>{const data=persisted as Partial<OrganizationJobs>|undefined;return {...current,job:cleanJob(data?.job),receipts:cleanReceipts(data?.receipts)};},
}));
onStorageSynced((key,value)=>{
  if(key!=='knowledge-organization-jobs' || !value || typeof value!=='object')return;
  const state=(value as {state?:Partial<OrganizationJobs>}).state;
  if(state)useOrganizationJobs.setState({job:cleanJob(state.job),receipts:cleanReceipts(state.receipts)});
});
