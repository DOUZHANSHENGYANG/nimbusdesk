import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrganizationPreferences, automaticCandidates, runAutomaticOrganization } from './auto-organize.ts';

const notes = [
  {path:'08-收件箱/a.md',title:'A',kind:'inbox'},
  {path:'04-资源收藏/b.md',title:'B',kind:'resource'},
  {path:'08-收件箱/done.md',title:'Done',kind:'inbox',organized:true},
  {path:'08-收件箱/old.md',title:'Old',kind:'inbox'},
];
const captures = [{status:'archived',notePath:notes[3].path,archivedPath:notes[1].path}];
test('defaults to inbox, automatic template and no image upload; rejects invalid preferences', () => {
  assert.deepEqual(normalizeOrganizationPreferences(null), {scope:'inbox',template:'auto',instructions:'',sendImages:false,schedule:{enabled:false,time:'20:00'}});
  assert.deepEqual(normalizeOrganizationPreferences({scope:'everywhere',template:'../../bad',instructions:42,sendImages:'yes'}), normalizeOrganizationPreferences(null));
});
test('daily schedule accepts an explicit local time and rejects malformed values',()=>{
  assert.deepEqual(normalizeOrganizationPreferences({schedule:{enabled:true,time:'08:05'}}).schedule,{enabled:true,time:'08:05'});
  for(const time of ['8:05','24:00','20:60','../x',null])assert.deepEqual(normalizeOrganizationPreferences({schedule:{enabled:'yes',time}}).schedule,{enabled:false,time:'20:00'});
});
test('automatic selection skips unchanged completed notes, archived sources and unsaved editor', () => {
  assert.deepEqual(automaticCandidates(notes,captures,{scope:'inbox'}).map(n=>n.path),[notes[0].path]);
  assert.deepEqual(automaticCandidates(notes,captures,{scope:'managed'},notes[0].path).map(n=>n.path),[notes[1].path]);
  assert.equal(automaticCandidates([{...notes[0],organized:false}],[],{scope:'inbox'}).length,1);
});
test('processes each note separately, forwards preferences and never persists a failed AI reply', async () => {
  const calls=[]; const progress=[];
  const result = await runAutomaticOrganization(notes.slice(0,2),normalizeOrganizationPreferences({scope:'managed',instructions:'保留代码'}),{
    load:async note=>[{note:{path:note.path,fingerprint:'fp'},capture:{title:note.title}}],
    suggest:async (material,prefs)=>{calls.push(['ai',material[0].note.path,prefs.instructions]);if(material[0].capture.title==='B')throw new Error('bad model');return {title:'Sorted',tags:['x'],content:'body',kind:'recipe'};},
    save:async (material,suggestion)=>{calls.push(['save',material[0].note.path,suggestion.kind]);return {...notes[0],path:'recipes/a.md'};},
    onProgress:p=>progress.push(p),shouldStop:()=>false,
  });
  assert.deepEqual(calls,[['ai',notes[0].path,'保留代码'],['save',notes[0].path,'recipe'],['ai',notes[1].path,'保留代码']]);
  assert.equal(result.completed.length,1);assert.equal(result.failed.length,1);assert.equal(progress.at(-1).processed,2);
});
test('cancellation during AI response prevents writing and starting another note',async()=>{
  let stopped=false;let saves=0;let loads=0;
  const result=await runAutomaticOrganization(notes,normalizeOrganizationPreferences(null),{
    load:async()=>{loads++;return [];},suggest:async()=>{stopped=true;return {};},save:async()=>{saves++;},shouldStop:()=>stopped,
  });
  assert.equal(loads,1);assert.equal(saves,0);assert.equal(result.cancelled,true);
});
test('fixed writing template enforces its category even when the model returns another valid category',async()=>{
  let kind;
  await runAutomaticOrganization(notes.slice(0,1),normalizeOrganizationPreferences({template:'recipe'}),{
    load:async()=>[],suggest:async()=>({title:'A',content:'B',tags:['x'],kind:'resource'}),
    save:async(_,suggestion)=>{kind=suggestion.kind;return notes[0];},shouldStop:()=>false,
  });
  assert.equal(kind,'recipe');
});
