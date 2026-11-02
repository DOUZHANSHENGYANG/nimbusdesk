import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const nativeRequire=createRequire(import.meta.url),cache=new Map();
function load(name='./github-core') {
 if(cache.has(name)) return cache.get(name).exports;
 const code=ts.transpileModule(readFileSync(new URL(`${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const m={exports:{}};cache.set(name,m);new Function('require','module','exports',code)(s=>s.startsWith('.')?load(s):nativeRequire(s),m,m.exports);return m.exports;
}
const core=load();

const row=(owner,name,{stars='9,416',gained='1,723',language='TypeScript',description='A demo &amp; tool'}={})=>`<article class="Box-row">
 <div class="float-right d-flex"><a href="/sponsors/${owner}"><svg><path d="m8 14.25.345"/></svg> Sponsor</a></div>
 <h2 class="h3 lh-condensed"><a href="/${owner}/${name}" data-view-component="true" class="Link"><span class="text-normal"> ${owner} / </span> ${name}</a></h2>
 <p class="col-9 color-fg-muted my-1 tmp-pr-4"> ${description} </p>
 <div class="f6 color-fg-muted mt-2"><span><span class="repo-language-color"></span><span itemprop="programmingLanguage">${language}</span></span>
 <a href="/${owner}/${name}/stargazers" class="Link"><svg aria-label="star"><path d="m8 .25 1.882 3.815"/></svg> ${stars}</a>
 <a href="/${owner}/${name}/forks" class="Link"><svg><path d="m8 1"/></svg> 42</a></div>
 <span class="d-inline-block float-sm-right"><svg><path d="m8 .25"/></svg> ${gained} stars today </span>
</article>`;

test('trending rows: names, language, description and star numbers survive svg markup',()=>{
 const items=core.parseTrendingHtml(`<main>${row('thedotmack','claude-mem')}${row('acme','kit',{stars:'307,994',gained:'882',language:'Shell',description:'Plain text'})}</main>`);
 assert.equal(items.length,2);
 assert.deepEqual(items.map(i=>i.fullName),['thedotmack/claude-mem','acme/kit']);
 assert.deepEqual(items.map(i=>i.stars),[9416,307994]);
 assert.deepEqual(items.map(i=>i.gained),[1723,882]);
 assert.deepEqual(items.map(i=>i.language),['TypeScript','Shell']);
 // svg path 里的数字不能被当成 star 数；实体要解码
 assert.equal(items[0].description,'A demo & tool');
 assert.equal(items[0].url,'https://github.com/thedotmack/claude-mem');
});

test('trending parser reports an empty list instead of guessing when the page changes',()=>{
 assert.deepEqual(core.parseTrendingHtml('<html><body><div class="Repository">nope</div></body></html>'),[]);
 assert.deepEqual(core.parseTrendingHtml(''),[]);
});

test('fork flag comes from the API payload, so no extra parent request is needed',()=>{
 const repo=core.normalizeRepo({id:7,name:'kit',full_name:'me/kit',fork:true,parent:{full_name:'upstream/kit'},stargazers_count:12,forks_count:3,default_branch:'trunk',html_url:'https://github.com/me/kit',pushed_at:'2026-10-30T00:00:00Z',topics:['cli',7]});
 assert.equal(repo.fork,true);
 assert.equal(repo.parentFullName,'upstream/kit');
 assert.equal(repo.defaultBranch,'trunk');
 assert.deepEqual(repo.topics,['cli']);
 assert.equal(core.normalizeRepo({name:'plain',fork:false}).fork,false);
 assert.equal(core.normalizeRepo({name:'plain'}).fork,false);
});

test('list paths and star calls hit the documented endpoints',()=>{
 assert.match(core.reposPath('mine'),/^https:\/\/api\.github\.com\/user\/repos\?per_page=100&page=1&sort=updated&affiliation=owner,collaborator$/);
 assert.match(core.reposPath('starred',2),/^https:\/\/api\.github\.com\/user\/starred\?per_page=100&page=2&sort=updated$/);
 assert.equal(core.starUrl('me/kit'),'https://api.github.com/user/starred/me/kit');
 assert.match(core.trendingFallbackUrl(7,new Date('2026-10-31T00:00:00Z')),/created:>2026-10-24/);
});

test('edge translate: request shape and response parsing',()=>{
 assert.match(core.edgeTranslateUrl('zh-Hans'),/translatetext\?from=&to=zh-Hans&isEnterpriseClient=false$/);
 assert.deepEqual(core.parseEdgeTranslation([{detectedLanguage:{language:'en'},translations:[{text:'你好，世界'}]}]),
   ['你好，世界']);
 assert.throws(()=>core.parseEdgeTranslation({error:'nope'}));
 assert.throws(()=>core.parseEdgeTranslation([{translations:[]}]));
});

test('selection translate prompt keeps the target language and the source text',()=>{
 const [system,user]=core.aiTranslatePrompt('Hello','zh-Hans');
 assert.equal(system.role,'system');
 assert.match(system.content,/zh-Hans/);
 assert.deepEqual(user,{role:'user',content:'Hello'});
});

test('entity decoding handles named and numeric forms',()=>{
 assert.equal(core.decodeEntities('a &amp; b &#39;c&#x27; d&#x2F;e'),"a & b 'c' d/e");
});

test('trending items can be read as repositories without pretending to know stars/forks',()=>{
 const repo=core.repoFromTrending({fullName:'acme/kit',owner:'acme',name:'kit',url:'https://github.com/acme/kit',description:'d',language:null,stars:5,gained:9});
 assert.equal(repo.defaultBranch,'main');
 assert.equal(repo.fork,false);
 assert.equal(repo.stars,5);
});

test('repo search matches name, description, language and topics',()=>{
 const repo={fullName:'acme/kit',description:'A build tool',language:'Rust',topics:['cli']};
 assert.equal(core.repoMatches(repo,''),true);
 assert.equal(core.repoMatches(repo,'BUILD'),true);
 assert.equal(core.repoMatches(repo,'rust'),true);
 assert.equal(core.repoMatches(repo,'acme/'),true);
 assert.equal(core.repoMatches(repo,'python'),false);
});

test('token input loses stray whitespace from copy-paste',()=>{
 assert.equal(core.cleanToken(' ghp_abc\n'),'ghp_abc');
});

test('translation falls back to AI only when the free endpoint fails',async()=>{
 const ok={text:'译文',engine:'edge'}, ai={text:'AI 译文',engine:'ai'};
 let used='';
 assert.deepEqual(await core.translateWithFallback(async()=>ok,async()=>{used='ai';return ai;}),ok);
 assert.equal(used,'','a working primary must not touch the fallback');
 assert.deepEqual(await core.translateWithFallback(async()=>{throw new Error('HTTP 400');},async()=>ai),ai);
 const primary=new Error('HTTP 400');
 await assert.rejects(core.translateWithFallback(async()=>{throw primary;},async()=>{throw new Error('no provider');}),/HTTP 400/);
});

test('repo paging uses the API page size and caps at five pages',()=>{
 assert.equal(core.PAGE_SIZE,100);
 assert.equal(core.MAX_PAGES,5);
 assert.equal(core.PAGE_SIZE < 1000, true, 'sanity: the page size stays the API maximum');
 assert.match(core.reposPath('mine',2),/page=2/);
});

test('pinned repositories float to the top and keep the rest in order',()=>{
 const rows=[{fullName:'a/one'},{fullName:'b/two'},{fullName:'c/three'}];
 const sorted=core.sortPinned(rows,new Set(['c/three','a/one']));
 assert.deepEqual(sorted.map(r=>r.fullName),['a/one','c/three','b/two']);
 assert.deepEqual(rows.map(r=>r.fullName),['a/one','b/two','c/three'],'the input order must not be mutated');
 assert.deepEqual(core.sortPinned(rows,new Set()).map(r=>r.fullName),['a/one','b/two','c/three']);
});

test('repo names must be owner/name in a filesystem-safe shape',()=>{
 assert.equal(core.validRepoFullName('dz/nimbus-desk'),true);
 assert.equal(core.validRepoFullName('a/b.c_d-e'),true);
 assert.equal(core.validRepoFullName('dz'),false);
 assert.equal(core.validRepoFullName('dz/../etc'),false);
 assert.equal(core.validRepoFullName('dz/'),false);
 assert.equal(core.validRepoFullName('dz/ni mb us'),false);
 assert.equal(core.validRepoFullName(42),false);
});

test('local github state rejects duplicate pins, duplicate links and bad folders',()=>{
 const pin={fullName:'a/one',pinnedAt:1}, link={projectId:'p1',fullName:'a/one',linkedAt:1};
 const base=()=>core.emptyGithubLocalData();
 assert.doesNotThrow(()=>core.validateGithubData({...base(),pins:[pin],links:[link],downloadDir:'E:/Downloads'}));
 assert.doesNotThrow(()=>core.validateGithubData(base()));
 assert.throws(()=>core.validateGithubData({...base(),pins:[pin,pin]}),/pin/);
 assert.throws(()=>core.validateGithubData({...base(),links:[link,link]}),/link/);
 assert.doesNotThrow(()=>core.validateGithubData({...base(),links:[link,{...link,projectId:'p2'}]}),"one repo may link to several projects");
 assert.doesNotThrow(()=>core.validateGithubData({...base(),links:[link,{...link,fullName:'a/two'}]}),"one project may link to several repos");
 assert.throws(()=>core.validateGithubData({...base(),downloadDir:'   '}),/folder/);
 assert.throws(()=>core.validateGithubData({...base(),links:[{...link,fullName:'../x'}]}),/link/);
});

test('a refresh reports which repos disappeared and which forks lost their upstream',()=>{
 const known=[{fullName:'dz/a'},{fullName:'dz/b'}];
 assert.deepEqual(core.detectGone(known,[{fullName:'dz/b'},{fullName:'dz/c'}]).map(r=>r.fullName),['dz/a']);
 assert.deepEqual(core.detectGone(known,[]).map(r=>r.fullName),['dz/a','dz/b']);
 assert.deepEqual(core.detectGone([],[{fullName:'dz/c'}]),[]);
 // fork 的 parent 消失 = 上游仓库被删；非 fork 没有上游可言
 assert.equal(core.upstreamGone({fork:true,parentFullName:null}),true);
 assert.equal(core.upstreamGone({fork:true,parentFullName:'up/a'}),false);
 assert.equal(core.upstreamGone({fork:false,parentFullName:null}),false);
});

test('known/missing snapshots are validated like the rest of the local state',()=>{ const repo={fullName:'a/one'};
 const base=()=>core.emptyGithubLocalData();
 assert.doesNotThrow(()=>core.validateGithubData({...base(),knownRepos:[repo],missing:[{repo:{fullName:'b/two'},since:1}]}));
 assert.throws(()=>core.validateGithubData({...base(),knownRepos:[repo,repo]}),/snapshot/);
 assert.throws(()=>core.validateGithubData({...base(),missing:[{repo:{fullName:'b/two'},since:-1}]}),/missing/);
 assert.throws(()=>core.validateGithubData({...base(),missing:[{repo:{fullName:'x'},since:1}]}),/missing/);
});

test('a sync marks vanished repos, keeps the rest, and clears ones that came back',()=>{
 const repo=(fullName)=>({fullName,stars:1});
 let data={...core.emptyGithubLocalData(),login:'dz',knownRepos:[repo('dz/a'),repo('dz/b')],missing:[{repo:repo('dz/old'),since:5}]};
 // 第二轮：b 还在、a 消失；更早那条 old 没再出现，继续保留（它确实还没回来）
 data=core.applySync(data,'dz',[repo('dz/b'),repo('dz/c')],100);
 assert.deepEqual(data.missing.map(e=>e.repo.fullName).sort(),['dz/a','dz/old']);
 assert.deepEqual(data.knownRepos.map(r=>r.fullName),['dz/b','dz/c']);
 assert.equal(data.missing.find(e=>e.repo.fullName==='dz/a').since,100,'newly vanished entries carry the sync time');
 assert.equal(data.missing.find(e=>e.repo.fullName==='dz/old').since,5,'older entries keep their original time');

 // 第三轮：a 和 old 都回来了 → 两条标记一起清掉
 data=core.applySync(data,'dz',[repo('dz/a'),repo('dz/b'),repo('dz/c'),repo('dz/old')],200);
 assert.deepEqual(data.missing,[]);

 // 再次消失 → 重新记一条，时间取这一次
 data=core.applySync(data,'dz',[repo('dz/b'),repo('dz/c')],300);
 assert.deepEqual(data.missing.map(e=>e.repo.fullName).sort(),['dz/a','dz/old']);
 assert.equal(data.missing.find(e=>e.repo.fullName==='dz/a').since,300);
});

test('switching accounts resets the baseline instead of reporting everything gone',()=>{
 const repo=(fullName)=>({fullName});
 const data={...core.emptyGithubLocalData(),login:'old',knownRepos:[repo('old/a'),repo('old/b')],missing:[{repo:repo('old/gone'),since:1}]};
 const next=core.applySync(data,'new',[repo('new/a')],10);
 assert.deepEqual(next.missing,[],'another account must not inherit the previous missing list');
 assert.deepEqual(next.knownRepos.map(r=>r.fullName),['new/a']);
 assert.equal(next.login,'new');
});

test('the account field itself is validated',()=>{
 const base=core.emptyGithubLocalData();
 assert.doesNotThrow(()=>core.validateGithubData({...base,login:'dz'}));
 assert.doesNotThrow(()=>core.validateGithubData({...base,login:null}));
 assert.throws(()=>core.validateGithubData({...base,login:'  '}),/account/);
 assert.throws(()=>core.validateGithubData({...base,login:42}),/account/);
});

test('readme cache keeps the newest entries and rejects oversized text',()=>{
 let readmes={};
 for(let i=0;i<core.README_CACHE_ENTRIES+3;i+=1)readmes=core.cacheReadme(readmes,`dz/repo-${i}`,`body ${i}`,i);
 assert.equal(Object.keys(readmes).length,core.README_CACHE_ENTRIES);
 assert.equal(readmes['dz/repo-0'],undefined,'the oldest entry is dropped');
 assert.ok(readmes[`dz/repo-${core.README_CACHE_ENTRIES+2}`],'the newest entry stays');
 // 超大文档与空文档不缓存，避免把本机状态撑爆
 const huge='x'.repeat(core.README_CACHE_BYTES+1);
 assert.deepEqual(core.cacheReadme(readmes,'dz/huge',huge,99),readmes);
 assert.deepEqual(core.cacheReadme(readmes,'dz/empty','   ',99),readmes);
 assert.deepEqual(core.cacheReadme(readmes,'not-a-repo','x',99),readmes);
});

test('the snapshot cache is validated like the rest of the local state',()=>{
 const base=core.emptyGithubLocalData();
 const cache=core.emptyGithubCache();
 assert.doesNotThrow(()=>core.validateGithubData({...base,cache}));
 assert.doesNotThrow(()=>core.validateGithubData({...base,cache:{...cache,viewer:{login:'dz',name:'',avatarUrl:''}}}));
 assert.throws(()=>core.validateGithubData({...base,cache:{...cache,viewer:{login:'  ',name:'',avatarUrl:''}}}),/cache/);
 assert.throws(()=>core.validateGithubData({...base,cache:{...cache,trendingFallback:'no'}}),/cache/);
 assert.throws(()=>core.validateGithubData({...base,cache:{...cache,readmes:{'dz/x':{markdown:1,at:1}}}}),/readme/);
 assert.throws(()=>core.validateGithubData({...base,cache:undefined}),/cache/);
});
