import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestGate, normalizeSearchSettings, moveSelection, DEFAULT_SEARCH_SETTINGS } from './core.ts';
import * as core from './core.ts';

test('launchable file results rank before ordinary files without promoting similarly named directories', () => {
  const file = (id, score=10, kind='file') => ({id,kind,title:id,path:`C:/tools/${id}`,subtitle:'',snippet:'',score});
  const results=core.mergeSearchHits([file('notes.md',1000),file('folder.exe',2000,'folder'),file('run.PS1'),file('run.bat'),file('run.exe'),file('run.ps'),file('run.cmd')]);
  assert.ok(results.slice(0,5).every(item=>item.kind==='file' && /\.(exe|bat|ps1?|cmd)$/i.test(item.path)));
  assert.equal(results[5].id,'folder.exe');assert.equal(results[6].id,'notes.md');
  assert.deepEqual(core.mergeSearchHits([file('ordinary.txt',20),file('other.txt',10)]).map(hit=>hit.id),['ordinary.txt','other.txt']);
});

test('stored user configuration survives hydration and malformed fields fall back independently', () => {
  assert.deepEqual(normalizeSearchSettings({state:{shortcut:' Alt+K ',fileBackend:'everything',everythingInstance:'work'}}), {...DEFAULT_SEARCH_SETTINGS,shortcut:'Alt+K',fileBackend:'everything',everythingInstance:'work'});
  assert.deepEqual(normalizeSearchSettings({state:{shortcut:'',fileBackend:'invalid',everythingInstance:42}}), {...DEFAULT_SEARCH_SETTINGS,shortcut:'',fileBackend:'auto',everythingInstance:''});
  assert.equal(normalizeSearchSettings(null).shortcut, 'Ctrl+Alt+K');
});
test('document roots preserve explicit empty scope and validate additive settings independently', () => {
  assert.equal(normalizeSearchSettings(null).documentRoots,null);
  assert.deepEqual(normalizeSearchSettings({state:{documentRoots:[]}}).documentRoots,[]);
  const value=normalizeSearchSettings({state:{documentRoots:[' E:/文档 ',null,'E:/文档'],documentExcludes:['E:/文档/cache'],everythingPath:' C:/Apps/Everything.exe ',everythingAutoStart:true,documentIndexEnabled:false,pinyinEnabled:false}});
  assert.deepEqual(value.documentRoots,['E:/文档']);assert.deepEqual(value.documentExcludes,['E:/文档/cache']);
  assert.equal(value.everythingPath,'C:/Apps/Everything.exe');assert.equal(value.everythingAutoStart,true);assert.equal(value.documentIndexEnabled,false);assert.equal(value.pinyinEnabled,false);
});
test('one file from different providers retains highest score and content excerpt while business records remain distinct',()=>{
 const {mergeSearchHits,searchHitIdentity}=core;assert.equal(typeof mergeSearchHits,'function');
 const ipc={id:'ipc',kind:'file',path:'E:\\文档\\资料.pdf',title:'资料.pdf',subtitle:'',snippet:'',score:100};
 const content={...ipc,id:'content',path:'e:/文档/资料.pdf',score:70,snippet:'正文命中：验收要求'};
 const business={...content,id:'knowledge',kind:'knowledge',score:80};
 const results=mergeSearchHits([ipc],[content,business]);
 assert.equal(results.length,2);assert.equal(results[0].score,100);assert.equal(results[0].snippet,content.snippet);
 assert.equal(searchHitIdentity(ipc),searchHitIdentity(content));assert.notEqual(searchHitIdentity(ipc),searchHitIdentity(business));
});
test('a query response becomes stale immediately when input changes, including composition', () => {
  const gate = createRequestGate();
  const first = gate.invalidate(); assert.ok(gate.current(first));
  const second = gate.invalidate(); assert.ok(!gate.current(first)); assert.ok(gate.current(second));
  gate.invalidate(); assert.ok(!gate.current(second));
});
test('Windows extended local and UNC paths share an identity with ordinary provider paths', () => {
  const hit = path => ({ id:path,kind:'file',path,title:'资料.pdf',subtitle:'',snippet:'',score:1 });
  assert.equal(core.searchHitIdentity(hit('\\\\?\\E:\\文档\\资料.pdf')),core.searchHitIdentity(hit('e:/文档/资料.pdf')));
  assert.equal(core.searchHitIdentity(hit('\\\\?\\UNC\\SERVER\\共享\\资料.pdf')),core.searchHitIdentity(hit('\\\\server\\共享\\资料.pdf')));
  assert.equal(core.mergeSearchHits([hit('\\\\?\\UNC\\SERVER\\共享\\资料.pdf')],[hit('//server/共享/资料.pdf')]).length,1);
});
test('keyboard selection wraps in both directions and empty lists have no selection', () => {
  assert.equal(moveSelection(0,3,-1),2); assert.equal(moveSelection(2,3,1),0); assert.equal(moveSelection(0,0,1),-1);
});

test('filename indexing settings preserve empty scope, isolate content roots and clamp limits', () => {
  const defaults=normalizeSearchSettings(null);
  assert.equal(defaults.hideNoisyResults,true);assert.equal(defaults.nameRoots,null);assert.equal(defaults.nameIndexLimit,250000);
  const value=normalizeSearchSettings({state:{nameRoots:[],documentRoots:['E:/正文'],hideNoisyResults:false,nameIndexLimit:3}});
  assert.deepEqual(value.nameRoots,[]);assert.deepEqual(value.documentRoots,['E:/正文']);assert.equal(value.hideNoisyResults,false);assert.equal(value.nameIndexLimit,10000);
  assert.equal(normalizeSearchSettings({state:{nameIndexLimit:9000000}}).nameIndexLimit,5000000);
  assert.equal(normalizeSearchSettings({state:{nameIndexLimit:'bad'}}).nameIndexLimit,250000);
  assert.deepEqual(normalizeSearchSettings({state:{nameRoots:[' E:/应用 ',null,'E:/应用']}}).nameRoots,['E:/应用']);
});

test('home groups preserve pin order, hide duplicate recent hits and filter category', () => {
  assert.equal(typeof core.searchHomeGroups,'function');
  const app={id:'app:one',kind:'app',title:'应用',subtitle:'',snippet:'',score:1};
  const note={...app,id:'note:one',kind:'knowledge',title:'笔记'};
  const home={pinned:[app],recent:[app,note]};
  assert.deepEqual(core.searchHomeGroups(home,'all'),{pinned:[app],recent:[note]});
  assert.deepEqual(core.searchHomeGroups(home,'app'),{pinned:[app],recent:[]});
  assert.notEqual(core.searchHitIdentity(app),core.searchHitIdentity({...app,id:'app:two'}));
});

test('mixed provider merges preserve app priority ahead of executable files and ordinary hits', () => {
  const app={id:'app:wechat',kind:'app',title:'微信',subtitle:'',snippet:'',score:10};
  const executable={...app,id:'exe',kind:'file',title:'wechat.exe',path:'C:/Apps/wechat.exe',score:1000};
  const document={...app,id:'note',kind:'knowledge',title:'微信使用说明',score:2000};
  assert.deepEqual(core.mergeSearchHits([document,app],[executable]).map(hit=>hit.id),['app:wechat','exe','note']);
});
