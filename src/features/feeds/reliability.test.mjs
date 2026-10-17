import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

let sequence = 0;
async function load(path, dependencies = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const key = `__feedsTest${++sequence}`;
  const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import[\s\S]*?;\s*/gm, '');
  if (path === '../../stores/feeds.ts') dependencies = { persist, createJSONStorage, tauriJsonStorage:{getItem:()=>null,setItem:()=>{}}, useCustomFeeds:{getState:()=>({feeds:[]})}, ...dependencies };
  globalThis[key] = dependencies;
  try { return await import(`data:text/javascript;base64,${Buffer.from(`const {${Object.keys(dependencies).join(',')}}=globalThis.${key};\n${code}`).toString('base64')}`); }
  finally { delete globalThis[key]; }
}
const entry = (title) => ({id:title,title,url:`https://github.com/example/${title}`});
const deferred = () => { let resolve; const promise=new Promise(done=>resolve=done); return {promise,resolve}; };

test('personal RSS sources precede built-ins and cannot shadow a built-in id', async () => {
  const SOURCE_BASE=[{id:'github-trending',name:'GitHub',group:'技术'}];
  const feeds=[{id:'rss:first',name:'First',group:'技术',url:'https://first.test/feed'},{id:'rss:second',name:'Second',group:'项目',url:'https://second.test/feed'},{id:'github-trending',url:'https://collision.test/feed'}];
  const {mergedSources}=await load('../../sources/custom.ts',{SOURCE_BASE,useCustomFeeds:{getState:()=>({feeds})},fetchRssEntries:async()=>[]});
  assert.deepEqual(mergedSources().map(source=>source.id),['rss:first','rss:second','github-trending']);
});

test('initial view prefers the first RSS but preserves a source explicitly selected later', async () => {
  const sources=[{id:'rss:first',fetch:async()=>[]},{id:'github-trending',fetch:async()=>[]}];
  const {useFeeds}=await load('../../stores/feeds.ts',{create,mergedSources:()=>sources});
  await useFeeds.getState().initialize();assert.equal(useFeeds.getState().activeId,'rss:first');
  useFeeds.getState().selectSource('github-trending');await useFeeds.getState().initialize();
  assert.equal(useFeeds.getState().activeId,'github-trending');
});

test('same-source refreshes share one request and loading stays true until it finishes', async () => {
  const gate=deferred();let calls=0;
  const {useFeeds}=await load('../../stores/feeds.ts',{create,mergedSources:()=>[{id:'github-trending',fetch:()=>{calls++;return gate.promise;}}]});
  const first=useFeeds.getState().refresh();const second=useFeeds.getState().refresh();
  assert.equal(calls,1);assert.equal(useFeeds.getState().loading['github-trending'],true);
  gate.resolve([entry('new')]);await Promise.all([first,second]);
  assert.equal(useFeeds.getState().entriesBySource['github-trending'][0].title,'new');
  assert.equal(useFeeds.getState().loading['github-trending'],false);
});

test('failed refresh preserves cached entries and last successful timestamp', async () => {
  let failure=false;
  const {useFeeds}=await load('../../stores/feeds.ts',{create,mergedSources:()=>[{id:'github-trending',fetch:async()=>{if(failure)throw Error('offline');return [entry('cached')];}}]});
  await useFeeds.getState().refresh();
  const last=useFeeds.getState().lastFetchedAt['github-trending'];assert.ok(last>0);
  failure=true;await useFeeds.getState().refresh();
  assert.equal(useFeeds.getState().entriesBySource['github-trending'][0].title,'cached');
  assert.equal(useFeeds.getState().lastFetchedAt['github-trending'],last);
  assert.equal(useFeeds.getState().error['github-trending'],'offline');
  assert.equal(useFeeds.getState().loading['github-trending'],false);
});

test('a synchronously failing source can be retried', async () => {
  let calls=0;
  const {useFeeds}=await load('../../stores/feeds.ts',{create,mergedSources:()=>[{id:'github-trending',fetch:()=>{if(++calls===1)throw Error('sync failure');return Promise.resolve([entry('recovered')]);}}]});
  await useFeeds.getState().refresh();await useFeeds.getState().refresh();
  assert.equal(calls,2);assert.equal(useFeeds.getState().entriesBySource['github-trending'][0].title,'recovered');
});

const rss=()=>load('../../sources/rss.ts',{XMLParser,XMLValidator,httpText:async()=>{throw Error('unexpected request');}});
test('RSS preserves full encoded article separately from its short description', async () => {
  const {parseRssFeed}=await rss();
  const html='<h1>Daily news</h1><h2>Tools</h2><p>First paragraph.</p><ul><li>Second story</li></ul>';
  const [article]=parseRssFeed(`<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>2026-10-17</title><link>https://daily.test/post</link><description>Short excerpt…</description><content:encoded><![CDATA[${html}]]></content:encoded></item></channel></rss>`,'https://daily.test/feed').entries;
  assert.deepEqual(article.content,{format:'html',value:html});
  assert.equal(article.extra.hover,'Short excerpt…');
});
test('Atom plain text remains text and collected articles keep the complete reading content', async () => {
  const {parseRssFeed}=await rss();
  const [article]=parseRssFeed('<feed><entry><title>Note</title><link href="https://text.test/note"/><content type="text">First paragraph.\n\nSecond paragraph.</content></entry></feed>','https://text.test/feed').entries;
  assert.deepEqual(article.content,{format:'text',value:'First paragraph.\n\nSecond paragraph.'});
  const {useFavorites}=await load('../../stores/favorites.ts',{create,persist,createJSONStorage,tauriJsonStorage:{getItem:async()=>null,setItem:async()=>{}}});
  useFavorites.getState().toggle(article,'Daily');
  assert.deepEqual(useFavorites.getState().items[0].content,article.content);
});
test('RSS probing returns title, resolves links, removes duplicate and unsafe entries', async () => {
  const {parseRssFeed}=await rss();
  const result=parseRssFeed('<rss><channel><title>Daily AI</title><item><title>First</title><link>/post</link></item><item><title>Duplicate</title><link>/post</link></item><item><title>Unsafe</title><link>javascript:alert(1)</link></item></channel></rss>','https://daily.example/rss.xml');
  assert.equal(result.title,'Daily AI');assert.equal(result.entries.length,1);
  assert.equal(result.entries[0].url,'https://daily.example/post');
});
test('Atom prefers published time and HTML alternate links over self links', async () => {
  const {parseRssFeed}=await rss();
  const result=parseRssFeed('<feed><title>Atom</title><entry><title>Item</title><link rel="self" href="/api/item"/><link rel="alternate" href="/article"/><published>2025-01-01T00:00:00Z</published><updated>2026-01-01T00:00:00Z</updated></entry></feed>','https://atom.example/feed');
  assert.equal(result.entries[0].url,'https://atom.example/article');
  assert.equal(result.entries[0].pubDate,Date.parse('2025-01-01T00:00:00Z'));
});
test('empty valid feeds are accepted while HTML and malformed XML are rejected', async () => {
  const {parseRssFeed}=await rss();
  assert.deepEqual(parseRssFeed('<rss><channel><title>Empty</title></channel></rss>','https://e.test/rss').entries,[]);
  assert.throws(()=>parseRssFeed('<html><body>blocked</body></html>','https://e.test/rss'));
  assert.throws(()=>parseRssFeed('<rss><channel></rss>','https://e.test/rss'));
});
test('subscription validation rejects placeholders, credentials, and unsupported schemes', async () => {
  const {normalizeFeedUrl}=await rss();
  for(const url of ['https://rsshub.app/user/...','ftp://e.test/rss','https://user:password@e.test/rss','broken'])assert.throws(()=>normalizeFeedUrl(url));
  assert.equal(normalizeFeedUrl(' https://DAILY.juya.uk/rss.xml#fragment '),'https://daily.juya.uk/rss.xml');
});

const network=()=>load('./github-network.ts');
test('GitHub fallback tries routes in order and rejects empty or non-GitHub data', async () => {
  const {fetchGithubRoutes}=await network();const calls=[];
  const routes=[{id:'direct',name:'Direct',url:'https://github.com/trending',format:'html',enabled:true},{id:'bad',name:'Bad',url:'https://bad.test/feed',format:'rss',enabled:true},{id:'good',name:'Good',url:'https://good.test/feed',format:'rss',enabled:true}];
  const result=await fetchGithubRoutes(routes,async route=>{calls.push(route.id);return route.id==='direct'?[]:route.id==='bad'?[{id:'bad',title:'Ad',url:'https://evil.test/login'}]:[entry('valid')];});
  assert.deepEqual(calls,['direct','bad','good']);assert.equal(result.route.id,'good');assert.equal(result.entries[0].url,'https://github.com/example/valid');
});
test('GitHub fallback respects abort instead of trying another mirror', async () => {
  const {fetchGithubRoutes}=await network();let calls=0;const controller=new AbortController();
  await assert.rejects(fetchGithubRoutes([{id:'one'},{id:'two'}],async()=>{calls++;controller.abort();throw new DOMException('Aborted','AbortError');},controller.signal),{name:'AbortError'});
  assert.equal(calls,1);
});
test('saved GitHub routes are bounded and reject credentials, placeholders and unsafe protocols', async () => {
  const {normalizeGithubRoutes}=await network();
  const routes=normalizeGithubRoutes([{id:'a',name:'Good',url:'https://a.test/feed',format:'rss',enabled:true},{id:'b',url:'javascript:alert(1)',format:'rss'},{id:'c',url:'https://user:secret@a.test/feed',format:'rss'}]);
  assert.equal(routes.length,1);assert.equal(routes[0].name,'Good');
});

test('HTTP cancellation stops waiting even when a native body read stalls', {timeout:1000}, async () => {
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>({ok:true,text:()=>new Promise(()=>{})});
  const controller=new AbortController();
  const {httpText}=await load('../../sources/http.ts');
  const reading=httpText('https://stalled.test/feed',{signal:controller.signal});
  controller.abort(new DOMException('Cancelled','AbortError'));
  try{await assert.rejects(reading,{name:'AbortError'});}
  finally{globalThis.fetch=previous;}
});


test('daily refresh includes subscriptions and built-ins, persists receipts and repeats only next local day', async () => {
  let disk=null;const counts={rss:0,hot:0};
  const sources=[{id:'rss:one',fetch:async()=>{counts.rss++;return [entry('cached')];}},{id:'hot',fetch:async()=>{counts.hot++;return [];}}];
  const dependencies={create,mergedSources:()=>sources,useCustomFeeds:{getState:()=>({feeds:[{id:'rss:one'}]})},tauriJsonStorage:{getItem:()=>disk,setItem:(_,value)=>{disk=value;}}};
  const {useFeeds}=await load('../../stores/feeds.ts',dependencies);
  const day=new Date(2026,9,17,20,0);await useFeeds.getState().refreshDaily(day);await useFeeds.getState().refreshDaily(day);
  assert.deepEqual(counts,{rss:1,hot:1});assert.equal(JSON.parse(disk).state.entriesBySource['rss:one'][0].title,'cached');
  const restored=(await load('../../stores/feeds.ts',dependencies)).useFeeds;
  assert.equal(restored.getState().entriesBySource['rss:one'][0].title,'cached');
  await restored.getState().refreshDaily(day);assert.deepEqual(counts,{rss:1,hot:1});
  await restored.getState().refreshDaily(new Date(2026,9,18,0,1));assert.deepEqual(counts,{rss:2,hot:2});
  await restored.getState().refresh('rss:one');assert.equal(counts.rss,3);
});

test('manual refresh updates all sources even after today has already been fetched', async () => {
  let calls=0;
  const sources=['rss:first','hot'].map(id=>({id,fetch:async()=>{calls++;return [entry(id)];}}));
  const {useFeeds}=await load('../../stores/feeds.ts',{create,mergedSources:()=>sources});
  await useFeeds.getState().refreshDaily();assert.equal(calls,2);
  await useFeeds.getState().refreshAll();assert.equal(calls,4);
  await useFeeds.getState().refreshDaily();assert.equal(calls,4);
});

test('favorites show saved source names and recover old origins from cache or website', async () => {
  const {favoriteSourceName}=await load('./favorite-source.ts');
  const sources=[{id:'rss:daily',name:'橘鸦AI早报',homepage:'https://daily.juya.uk/rss.xml'},{id:'hn',name:'Hacker News',homepage:'https://news.ycombinator.com'}];
  assert.equal(favoriteSourceName({url:'https://daily.juya.uk/post',sourceName:'  橘鸦AI早报  '},sources,{}),'橘鸦AI早报');
  assert.equal(favoriteSourceName({url:'https://example.com/post'},sources,{hn:[{url:'https://example.com/post'}]}),'Hacker News');
  assert.equal(favoriteSourceName({url:'https://daily.juya.uk/post'},sources,{}),'橘鸦AI早报');
  assert.equal(favoriteSourceName({url:'https://unknown.test/post'},sources,{}),'unknown.test');
  assert.equal(favoriteSourceName({url:'broken'},sources,{}),'');
});

test('daily failures keep old content, record attempts, allow manual retry and include newly added feeds', async (t) => {
  // The initial manual refresh must happen on the previous day, regardless
  // of the machine's current date. TestContext restores the clock afterward.
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026,9,17,23,55) });
  let fails=false,calls=0;const feeds=[{id:'rss:one'}];
  const sources=[{id:'rss:one',fetch:async()=>{calls++;if(fails)throw Error('offline');return [entry('kept')];}},{id:'rss:two',fetch:async()=>[entry('new')]}];
  const {useFeeds}=await load('../../stores/feeds.ts',{create,mergedSources:()=>sources,useCustomFeeds:{getState:()=>({feeds})}});
  await useFeeds.getState().refresh('rss:one');fails=true;
  const day=new Date(2026,9,18,0,1);t.mock.timers.setTime(day.getTime());await useFeeds.getState().refreshDaily(day);await useFeeds.getState().refreshDaily(day);
  assert.equal(calls,2);assert.equal(useFeeds.getState().entriesBySource['rss:one'][0].title,'kept');assert.equal(useFeeds.getState().error['rss:one'],'offline');
  fails=false;await useFeeds.getState().refresh('rss:one');assert.equal(calls,3);
  feeds.push({id:'rss:two'});await useFeeds.getState().refreshDaily(day);assert.equal(useFeeds.getState().entriesBySource['rss:two'][0].title,'new');
});

test('background RSS updates are bounded to two concurrent requests and duplicate starts share them', async () => {
  const gate=deferred();let active=0,maximum=0,calls=0;
  const feeds=Array.from({length:5},(_,i)=>({id:`rss:${i}`}));
  const sources=feeds.map(feed=>({...feed,fetch:async()=>{calls++;maximum=Math.max(maximum,++active);await gate.promise;active--;return [];}}));
  const {useFeeds}=await load('../../stores/feeds.ts',{create,mergedSources:()=>sources,useCustomFeeds:{getState:()=>({feeds})}});
  const day=new Date(2026,9,17);const first=useFeeds.getState().refreshDaily(day);const second=useFeeds.getState().refreshDaily(day);
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(calls,2);assert.equal(maximum,2);
  gate.resolve();await Promise.all([first,second]);assert.equal(calls,5);assert.equal(maximum,2);
});

test('opening the feeds page again uses existing cache instead of forcing another refresh', async () => {
  let calls=0;const {useFeeds}=await load('../../stores/feeds.ts',{create,mergedSources:()=>[{id:'rss:one',fetch:async()=>{calls++;return [entry('once')];}}]});
  await useFeeds.getState().initialize();await useFeeds.getState().initialize();assert.equal(calls,1);
});

test('runtime waits for cache and subscriptions hydration, runs on app start and focus, and cleans up', async () => {
  const target=new EventTarget();let ready=false,runs=0;const callbacks=new Set();
  const subscriptions={persist:{hasHydrated:()=>ready,onFinishHydration:fn=>{callbacks.add(fn);return()=>callbacks.delete(fn);}},subscribe:()=>()=>{}};
  const state={refreshDaily:async()=>{runs++;}};
  const cache={...subscriptions,getState:()=>state};
  const {startFeedsRuntime}=await load('./runtime.tsx',{useEffect:()=>{},useFeeds:cache,useCustomFeeds:subscriptions});
  const stop=startFeedsRuntime(target);assert.equal(runs,0);ready=true;for(const fn of callbacks)fn();
  assert.equal(runs,1);target.dispatchEvent(new Event('focus'));assert.equal(runs,2);stop();target.dispatchEvent(new Event('focus'));assert.equal(runs,2);
});


test('full-content RSS requests allow 30 seconds while respecting caller cancellation', async () => {
  const calls=[];const signal=new AbortController().signal;
  const {fetchRssEntries}=await load('../../sources/rss.ts',{XMLParser,XMLValidator,httpText:async(...args)=>{calls.push(args);return '<rss><channel><title>Slow feed</title></channel></rss>';}});
  await fetchRssEntries('https://slow.test/feed',50,signal);
  assert.equal(calls[0][1].signal,signal);assert.equal(calls[0][2],30000);
});

test('Bing search supports RSS results when its HTML result list is unavailable', async () => {
  const {parseRssFeed}=await rss();const calls=[];
  const {searchBing}=await load('../../search/providers/bing.ts',{parseRssFeed,httpText:async url=>{calls.push(url);return '<rss><channel><item><title>SQLite Documentation</title><link>https://sqlite.org/docs.html</link><description>SQLite database documentation</description></item></channel></rss>';}});
  assert.deepEqual(await searchBing('SQLite database documentation',1),[{title:'SQLite Documentation',url:'https://sqlite.org/docs.html',content:'SQLite database documentation'}]);
  assert.ok(calls[0].includes('format=rss'));assert.ok(calls[0].includes('SQLite%20database%20documentation'));
});

test('search waits for saved search settings and uses the configured backend', async () => {
  let ready=false;const calls=[];
  const {searchWeb}=await load('../../search/index.ts',{aiSettingsReady:async()=>{ready=true;},useAiSettings:{getState:()=>({searchProvider:ready?'tavily':'bing'})},searchBing:async()=>{calls.push('bing');return [];},searchTavily:async()=>{calls.push('tavily');return [];}});
  await searchWeb('SQLite');assert.deepEqual(calls,['tavily']);
});

test('AI search synthesizes retrieved sources through the shared model and returns references', async () => {
  const sources=[{title:'SQLite',url:'https://sqlite.org',content:'Embedded SQL database engine'}];let request;
  const {ask}=await load('../../search/pipeline.ts',{searchWeb:async()=>sources,chatStream:async(messages,delta)=>{request=messages;delta('An embedded database [1].');return 'An embedded database [1].';}});
  let answer='';const result=await ask('What is SQLite?',chunk=>{answer+=chunk;});
  assert.equal(result.answer,answer);assert.deepEqual(result.sources,sources);assert.ok(request[1].content.includes('https://sqlite.org'));
});
