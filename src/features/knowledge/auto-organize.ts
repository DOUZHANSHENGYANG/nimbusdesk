import type { OrganizeMaterial } from './organize';
import type { CaptureRecord, KnowledgeNote, OrganizeSuggestion } from './types';

export interface OrganizationPreferences {
  scope: 'inbox' | 'managed';
  template: 'auto' | 'experience' | 'recipe' | 'resource';
  instructions: string;
  sendImages: boolean;
  schedule: { enabled: boolean; time: string };
}
export function normalizeOrganizationPreferences(value: unknown): OrganizationPreferences {
  const item = value && typeof value === 'object' ? value as Partial<OrganizationPreferences> : {};
  return {scope:item.scope === 'managed' ? 'managed' : 'inbox',
    template:['experience','recipe','resource'].includes(item.template ?? '') ? item.template! : 'auto',
    instructions:typeof item.instructions === 'string' ? item.instructions.slice(0,8000) : '',sendImages:item.sendImages === true,
    schedule:{enabled:item.schedule?.enabled === true,time:typeof item.schedule?.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.schedule.time) ? item.schedule.time : '20:00'}};
}
export function automaticCandidates(notes: KnowledgeNote[], captures: CaptureRecord[], prefs: Pick<OrganizationPreferences,'scope'>, blockedPath?: string) {
  const archived = new Set(captures.filter(c=>c.status === 'archived' && c.notePath !== c.archivedPath).map(c=>c.notePath));
  return notes.filter(n=>n.path !== blockedPath && !n.organized && !archived.has(n.path) && (prefs.scope === 'managed' || n.kind === 'inbox'));
}
export interface OrganizationResult { completed: KnowledgeNote[]; failed: {path:string;error:string}[]; cancelled:boolean }
export interface OrganizationProgress { processed:number; total:number; title:string; phase?:'saving'; path?:string }
/** No cross-document merging. Cancellation after generation also prevents a pending write. */
export async function runAutomaticOrganization(notes: KnowledgeNote[], prefs: OrganizationPreferences, jobs: {
  load:(note:KnowledgeNote)=>Promise<OrganizeMaterial[]>;
  suggest:(materials:OrganizeMaterial[],prefs:OrganizationPreferences)=>Promise<OrganizeSuggestion>;
  save:(materials:OrganizeMaterial[],suggestion:OrganizeSuggestion)=>Promise<KnowledgeNote>;
  shouldStop:()=>boolean;
  onProgress?:(progress:OrganizationProgress)=>void;
}):Promise<OrganizationResult> {
  const result:OrganizationResult = {completed:[],failed:[],cancelled:false};
  let processed=0;
  for(const note of notes) {
    if(jobs.shouldStop())break;
    jobs.onProgress?.({processed,total:notes.length,title:note.title});
    try {
      const material=await jobs.load(note);
      if(jobs.shouldStop())break;
      const suggestion=await jobs.suggest(material,prefs);
      if(jobs.shouldStop())break;
      if(prefs.template!=='auto')suggestion.kind=prefs.template;
      result.completed.push(await jobs.save(material,suggestion));
    } catch(error) { result.failed.push({path:note.path,error:error instanceof Error ? error.message : String(error)}); }
    processed++;
    jobs.onProgress?.({processed,total:notes.length,title:note.title});
  }
  result.cancelled=jobs.shouldStop();
  return result;
}
