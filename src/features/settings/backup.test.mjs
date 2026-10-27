import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { cleanProvider, getProviderModels } from "../ai/core.ts";
import { collectAttachmentPaths, validateAttachmentFiles } from "./backup-files.ts";

const path = "modules/plans/tasks/task/attachments/file/example.bin";
const attachment = { id: "file", name: "example.bin", path, size: 3, createdAt: 1 };
const plans = { state: { days: { "2026-10-17": [{ id: "task", title: "Todo", attachments: [attachment] }] } }, version: 3 };
const material = { path, dataBase64: "AAEC" };
const source = await readFile(new URL("./backup.ts", import.meta.url), "utf8");
let sequence = 0;
const require=createRequire(import.meta.url), projectModules=new Map();
function projectModule(name){if(projectModules.has(name))return projectModules.get(name).exports;const module={exports:{}};projectModules.set(name,module);const url=new URL(`../projects/${name}.ts`,import.meta.url);const code=ts.transpileModule(readFileSync(url,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(id=>id.startsWith('.')?projectModule(id):require(id),module,module.exports);return module.exports;}
const projectBackup=projectModule('./backup');
async function loadBackup(dependencies) {
  const key = `__backupTest${++sequence}`;
  // `files` 导出走 files_load（行级表）：默认给一个「空表」的桩，需要断言的用例自己覆盖 invoke
  globalThis[key] = { cleanProvider, getProviderModels, collectAttachmentPaths, validateAttachmentFiles, invoke: async () => null, ...projectBackup, ...dependencies };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText
    .replace(/^import[\s\S]*?from ["'][^"']+["'];\r?\n/gm, "")
    .replace(/import\("([^"]+)"\)/g, (_, name) => `getModule(${JSON.stringify(name)})`);
  const names = "pickBackupOpenPath,pickBackupSavePath,readBackup,readJson,restoreDirTree,scanDirTree,writeBackup,writeJson,flushAllStorage,acceptCommittedStorage,useSettings,invoke,cleanProvider,getProviderModels,collectAttachmentPaths,validateAttachmentFiles,readZenBackup,mergeZenBackup,rewriteMergedPlanLinks,assertPlanLinks,getModule";
  const module = await import(`data:text/javascript;base64,${Buffer.from(`const {${names}}=globalThis.${key};\n${code}`).toString("base64")}`);
  delete globalThis[key];
  return module;
}
function store(initial) {
  let state = initial;
  return { getState: () => state, setState: (patch) => { state = { ...state, ...patch }; } };
}
const backup = (data, files = []) => ({ kind: "nimbusdesk-backup", app: "nimbusdesk", schema: 3, exportedAt: "2026-10-17", data, attachments: files });

test("news fallback preferences are included in full backups", async () => {
  const value={state:{routes:[{id:'rss',name:'RSS',url:'https://rss.test/feed',format:'rss',enabled:true}]},version:1};
  const api=await loadBackup({readJson:async key=>key==='feed-network'?value:null,invoke:async()=>[]});
  const exported=await api.buildBackup({includeDirs:false});
  assert.deepEqual(exported.data['feed-network'],value);
});

test("collects deduplicated attachment files from active tasks and archived subtasks", () => {
  const archive = { state: { days: { "2026-10-16": { tasks: [{ id: "child", parentId: "root", attachments: [attachment] }] } } } };
  assert.deepEqual(collectAttachmentPaths({ plans, "plans-archive": archive }), [path]);
  assert.deepEqual(validateAttachmentFiles({ plans }, [material]), [material]);
  assert.throws(() => validateAttachmentFiles({ plans }, []), /missing/);
  assert.throws(() => validateAttachmentFiles({ plans }, [{ ...material, dataBase64: "AA==" }]), /size-mismatch/);
  assert.throws(() => validateAttachmentFiles({ plans }, [{ ...material, dataBase64: "bad!" }]), /base64/);
  assert.throws(() => validateAttachmentFiles({ plans }, [material, material]), /invalid-backup-attachment/);
});

test("rejects unsafe metadata and attachment totals above the raw backup limit", () => {
  const make = (attachments) => ({ plans: { days: { day: [{ attachments }] } } });
  assert.throws(() => collectAttachmentPaths(make([{ ...attachment, path: "../outside" }])), /invalid-task-attachment/);
  assert.throws(() => collectAttachmentPaths(make([1, 2, 3].map((id) => ({ ...attachment, path: path.replace("/file/", `/file${id}/`), size: 64 * 1024 * 1024 })))), /too-large/);
});

test("exports all current module keys, attachment bytes and sanitized provider metadata", async () => {
  const read = [];
  const provider = { id: "p", name: "Local", model: "m", baseUrl: "http://localhost:8000/v1", vision: false, apiKey: "must-be-removed" };
  const filesSnapshot = { categories: [{ id: "work", name: "工作", createdAt: 1 }], items: [{ id: "a", categoryId: "work", type: "file", title: "A", path: "E:/a.txt", tags: [], createdAt: 1 }] };
  const api = await loadBackup({
    readJson: async (key) => { read.push(key); return key === "plans" ? plans : key === "ai-providers" ? { state: { providers: [provider], llmApiKey: "also-removed" }, version: 1 } : null; },
    invoke: async (command, args) => {
      // `files` 走行级表：导出时从表里读，不再是 module_state 里的整份 JSON
      if (command === "files_load") return filesSnapshot;
      assert.equal(command, "task_attachments_export"); assert.deepEqual(args, { paths: [path] }); return [material];
    },
  });
  const result = await api.buildBackup({ includeDirs: false });
  // 除 files 之外的键都还从 readJson 读；files 单独走 files_load
  assert.deepEqual(read, api.BACKUP_KEYS.filter((key) => key !== "files"));
  for (const key of ["reminders", "favorites", "custom-feeds", "ai-providers", "knowledge-settings"]) assert.ok(read.includes(key));
  assert.ok(!read.includes("ai-settings"));
  assert.deepEqual(result.data.files, { state: filesSnapshot, version: 2 });
  assert.deepEqual(result.attachments, [material]);
  assert.ok(!JSON.stringify(result).includes("must-be-removed"));
  assert.ok(!JSON.stringify(result).includes("also-removed"));
});

test("backup roundtrip preserves per-model parameters and an independent image model without credentials", async () => {
  const provider = { id: "shared", name: "Shared", baseUrl: "http://localhost:8000/v1", model: "text", vision: false, apiKey: "private", models: [{ id: "text", vision: false, parameters: { temperature: 0, maxTokens: 1024, apiKey: "private" } }, { id: "vision", vision: true, parameters: { topP: .5 } }] };
  const settings = { providers: [provider], defaultTextId: "shared", defaultVisionId: "shared", defaultVisionModel: "vision" };
  const target = store({ providers: [], defaultTextId: null, defaultVisionId: null, defaultVisionModel: null });
  const api = await loadBackup({ readJson: async (key) => key === "ai-providers" ? { state: settings, version: 1 } : null, getModule: async () => ({ useProviders: target }) });
  const snapshot = await api.buildBackup({ includeDirs: false });
  assert.equal(JSON.stringify(snapshot).includes("private"), false);
  await api.mergeBackup(snapshot, { overwriteSettings: false });
  assert.equal(target.getState().defaultVisionModel, "vision");
  assert.equal(target.getState().defaultVisionId, "shared");
  assert.deepEqual(target.getState().providers[0].models, [{ id: "text", vision: false, parameters: { temperature: 0, maxTokens: 1024 } }, { id: "vision", vision: true, parameters: { topP: .5 } }]);
});

test("older schemas stay readable, while incomplete material fails before mutation", async () => {
  const api = await loadBackup({ invoke: () => assert.fail("must not write") });
  assert.equal(api.parseBackup(JSON.stringify({ ...backup({}), schema: 1, attachments: undefined })).schema, 1);
  // schema 2 的老包里还带着一份 `todo-papers`。纸片删掉之后它必须被安静忽略，
  // 而不是让整包恢复失败 —— 「旧备份仍可读」这条就是靠这里钉住的。
  const legacy = { ...backup({ "todo-papers": { papers: { today: { open: true } }, order: ["today"] } }), schema: 2 };
  assert.equal(api.parseBackup(JSON.stringify(legacy)).schema, 2);
  assert.deepEqual(api.backupKeysOf(legacy), [], "旧包里那份 todo-papers 不再算一个要恢复的模块");
  assert.throws(() => api.parseBackup(JSON.stringify({ ...backup({}), schema: 0 })), /unsupported-schema/);
  assert.throws(() => api.parseBackup(JSON.stringify(backup({ plans }))), /missing/);
  await assert.rejects(api.mergeBackup(backup({ plans }), { overwriteSettings: false }), /missing/);
});

test("restores binary files before task state and keeps local entity/settings conflicts", async () => {
  const events = [];
  const usePlans = store({ days: {} });
  const originalSet = usePlans.setState;
  usePlans.setState = (patch) => { events.push("tasks"); originalSet(patch); };
  const useFavorites = store({ items: [{ id: "local", url: "local", title: "keep" }] });
  const useCustomFeeds = store({ feeds: [{ id: "same", name: "local" }] });
  const useReminderSettings = store({ enabled: true, advance: 10, notified: ["local"] });
  const useSettings = store({ theme: "dark", dataDir: "local" });
  const modules = {
    "@/features/plans/store": { usePlans }, "@/stores/favorites": { useFavorites }, "@/stores/custom-feeds": { useCustomFeeds },
    "@/stores/reminders": { useReminderSettings },
  };
  const api = await loadBackup({ useSettings, getModule: async (name) => modules[name], invoke: async (command, args) => {
    assert.equal(command, "task_attachments_import"); assert.deepEqual(args, { files: [material] }); events.push("files");
  } });
  await api.mergeBackup(backup({ plans, settings: { theme: "light" }, favorites: { items: [{ id: "new", url: "new" }] }, "custom-feeds": { feeds: [{ id: "same", name: "incoming" }, { id: "extra" }] }, reminders: { enabled: false, advance: 0, notified: ["incoming"] } }, [material]), { overwriteSettings: false });
  assert.deepEqual(events, ["files", "tasks"]);
  assert.equal(usePlans.getState().days["2026-10-17"][0].attachments[0].path, path);
  assert.equal(useSettings.getState().theme, "dark");
  assert.equal(useCustomFeeds.getState().feeds[0].name, "local");
  assert.equal(useReminderSettings.getState().enabled, true);
  assert.deepEqual(useReminderSettings.getState().notified, ["local", "incoming"]);
  assert.equal(useFavorites.getState().items.length, 2);
});

test("native material failures abort before restoring any module state", async () => {
  const api = await loadBackup({ invoke: async () => { throw new Error("missing-source"); }, getModule: () => assert.fail("must not touch metadata") });
  await assert.rejects(api.mergeBackup(backup({ plans }, [material]), { overwriteSettings: false }), /missing-source/);
});

test("export waits for pending storage writes before reading the snapshot", async () => {
  const events = [];
  const api = await loadBackup({
    pickBackupSavePath: async () => "backup.json",
    flushAllStorage: async () => { await new Promise((done) => setImmediate(done)); events.push("flushed"); },
    readJson: async () => { assert.equal(events[0], "flushed"); return null; },
    writeBackup: async () => { events.push("written"); return { path: "backup.json", bytes: 1 }; },
  });
  await api.exportBackup({ includeDirs: false });
  assert.deepEqual(events, ["flushed", "written"]);
});

test("import awaits pending and restored writes before applying settings", async () => {
  const events = [];
  const api = await loadBackup({
    pickBackupOpenPath: async () => "backup.json",
    flushAllStorage: async () => { await new Promise((done) => setImmediate(done)); events.push("flushed"); },
    readBackup: async () => { events.push("read"); return JSON.stringify(backup({})); },
    useSettings: store({ theme: "dark", lang: "zh" }),
    getModule: async (name) => name === "@/lib/theme" ? { applyTheme: () => events.push("theme") } : { changeLang: () => events.push("language") },
  });
  await api.importBackup({ overwriteSettings: false });
  assert.deepEqual(events, ["flushed", "read", "flushed", "theme", "language"]);
});

const zenProfile={id:'office',name:'Office',baseUrl:'https://example.test/zentao/',account:'me',apiVersion:'auto',executionIds:[],autoSync:true,syncMinutes:15,createdAt:1,updatedAt:1};
const zenState={connections:[zenProfile],syncStates:{office:{lastSyncAt:1,lastError:null,lastCount:3,resolvedVersion:'v1',authRequired:false}}};
test('full backups include strict public ZenTao metadata and reject secrets before exporting attachments',async()=>{
 const api=await loadBackup({readJson:async key=>key==='zentao'?{state:zenState,version:1}:null});const result=await api.buildBackup({includeDirs:false});assert.deepEqual(result.data.zentao,{state:zenState,version:1});assert.ok(api.BACKUP_KEYS.includes('zentao'));
 const bad={state:structuredClone(zenState),version:1};bad.state.connections[0].password='private';
 const unsafe=await loadBackup({readJson:async key=>key==='zentao'?bad:key==='plans'?plans:null,invoke:()=>assert.fail('validation must precede material export')});await assert.rejects(unsafe.buildBackup({includeDirs:false}),/field|metadata|credential/i);
 assert.throws(()=>api.parseBackup(JSON.stringify(backup({zentao:bad}))),/field|metadata|credential/i);
});
test('profile identity conflicts fail before attachment import or module mutation',async()=>{
 const incoming=structuredClone(zenState);incoming.connections[0].account='other';const useZentao=store(zenState);useZentao.persist={hasHydrated:()=>true};
 const api=await loadBackup({getModule:async name=>{assert.equal(name,'@/features/projects/zentao-store');return{useZentao};},invoke:()=>assert.fail('must validate before importing files')});
 await assert.rejects(api.mergeBackup(backup({zentao:{state:incoming,version:1},plans},[material]),{overwriteSettings:false}),/identity|instance|account/i);assert.equal(useZentao.getState(),zenState);
});
test('project restores commit three envelopes together and publish only the canonical committed values',async()=>{
 const {emptyProjectData}=projectModule('./types');const local=emptyProjectData();local.items=[{id:'a',title:'A',projectId:null,areaId:null,note:'',deadline:null,status:'todo',activeIterationId:null,createdAt:1,updatedAt:1},{id:'b',title:'B',projectId:null,areaId:null,note:'',deadline:null,status:'todo',activeIterationId:null,createdAt:1,updatedAt:1}];
 const incoming=structuredClone(local);incoming.items[1]={...incoming.items[1],status:'cancelled',mergedIntoId:'a',updatedAt:2};
 const active={state:{days:{day:[{id:'p',workItemId:'b',attachments:[attachment]}]}},version:4};const archive={state:{days:{old:{archivedAt:1,tasks:[{id:'child',workItemId:'b'}]}}},version:3};const baseProjects={state:local,version:1};
 const useProjects=store(local);useProjects.persist={hasHydrated:()=>true};const usePlans=store(active.state),usePlansArchive=store(archive.state);for(const value of[usePlans,usePlansArchive])value.persist={hasHydrated:()=>true};
 const events=[];let canonical;const api=await loadBackup({flushAllStorage:async()=>events.push('flush'),readJson:async key=>({projects:baseProjects,plans:active,'plans-archive':archive})[key],getModule:async name=>name==='@/features/projects/store'?{useProjects,projectData:s=>s}:name==='@/features/projects/backup'?projectBackup:{usePlans,usePlansArchive},invoke:async(command,args)=>{if(command==='task_attachments_import'){events.push('files');return;}assert.equal(command,'project_apply_remote_binding');events.push('transaction');assert.deepEqual(args.baseProjects,baseProjects);assert.deepEqual(args.basePlans,active);assert.deepEqual(args.baseArchive,archive);assert.equal(args.plans.state.days.day[0].workItemId,'a');assert.equal(args.archive.state.days.old.tasks[0].workItemId,'a');canonical={projects:args.projects,plans:{...args.plans,concurrent:'preserved'},archive:args.archive};return canonical;},acceptCommittedStorage:async values=>{events.push('publish');assert.deepEqual(values,{projects:canonical.projects,plans:canonical.plans,'plans-archive':canonical.archive});}});
 await api.mergeBackup(backup({projects:{state:incoming,version:1},plans:active},[material]),{overwriteSettings:false});assert.deepEqual(events,['flush','files','transaction','publish']);assert.equal(useProjects.getState(),local);assert.equal(usePlans.getState(),active.state);
});

test('restored connection metadata cannot resume automatic synchronization with machine-local credentials',async()=>{
 const useZentao=store({connections:[],syncStates:{}});useZentao.persist={hasHydrated:()=>true};
 const api=await loadBackup({getModule:async()=>({useZentao}),invoke:()=>assert.fail('profile restore must not access credentials or network')});
 await api.mergeBackup(backup({zentao:{state:zenState,version:1}}),{overwriteSettings:false});
 assert.equal(useZentao.getState().connections[0].autoSync,false);assert.equal(useZentao.getState().syncStates.office.authRequired,true);assert.equal(zenState.connections[0].autoSync,true);
});

test('full restore disables ordinary-field writes and commits restored intent as uncertain',async()=>{
 const {emptyProjectData}=projectModule('./types'),local=emptyProjectData(),incoming=emptyProjectData();
 const fields={title:'Remote',note:'',deadline:null,status:'todo'};
 incoming.items=[{id:'i',...fields,title:'Local',projectId:null,areaId:null,activeIterationId:null,createdAt:1,updatedAt:2}];
 incoming.remoteTasks=[{id:'office:task:7',connectionId:'office',remoteId:7,...fields,status:'wait',start:null,remoteProjectId:null,executionId:null,parentRemoteId:null,assignedTo:'me',teamAccounts:[],lastEditedDate:null,updatedAt:1}];
 incoming.remoteLinks=[{id:'office:task:7',connectionId:'office',remoteId:7,itemId:'i',baseline:fields,divergedFields:[],updatedAt:1}];
 incoming.remoteChanges=[{id:'office:task:7',connectionId:'office',remoteId:7,itemId:'i',status:'sending',base:fields,local:{...fields,title:'Local'},remote:fields,expected:fields,fields:['title'],lastError:null,updatedAt:2}];
 const profiles={connections:[{...zenProfile,writeFields:['title']}],syncStates:zenState.syncStates};
 const useProjects=store(local),usePlans=store({days:{}}),usePlansArchive=store({days:{}}),useZentao=store({connections:[],syncStates:{}});for(const value of[useProjects,usePlans,usePlansArchive,useZentao])value.persist={hasHydrated:()=>true};
 let committed;
 const api=await loadBackup({flushAllStorage:async()=>{},readJson:async key=>({state:key==='projects'?local:{days:{}},version:1}),getModule:async name=>name==='@/features/projects/store'?{useProjects,projectData:s=>s}:name==='@/features/projects/backup'?projectBackup:name==='@/features/projects/zentao-store'?{useZentao}:{usePlans,usePlansArchive},invoke:async(command,args)=>{assert.equal(command,'project_apply_remote_binding');committed=args;return{projects:args.projects,plans:args.plans,archive:args.archive};},acceptCommittedStorage:async()=>{}});
 await api.mergeBackup(backup({projects:{state:incoming,version:1},zentao:{state:profiles,version:1}}),{overwriteSettings:true});
 assert.equal(committed.projects.state.remoteChanges[0].status,'uncertain');assert.deepEqual(committed.projects.state.remoteChanges[0].local,incoming.remoteChanges[0].local);
 assert.deepEqual(useZentao.getState().connections[0].writeFields,[]);assert.equal(useZentao.getState().syncStates.office.authRequired,true);
});
test('connection edits made while restoring material are preserved',async()=>{
 const useZentao=store(structuredClone(zenState));useZentao.persist={hasHydrated:()=>true};const usePlans=store({days:{}});
 const api=await loadBackup({getModule:async name=>name==='@/features/projects/zentao-store'?{useZentao}:{usePlans},invoke:async()=>{useZentao.setState({connections:[{...useZentao.getState().connections[0],name:'Edited while copying',updatedAt:10}]});}});
 await api.mergeBackup(backup({zentao:{state:zenState,version:1},plans},[material]),{overwriteSettings:false});assert.equal(useZentao.getState().connections[0].name,'Edited while copying');assert.equal(useZentao.getState().connections[0].autoSync,false);
});
test('failed native project restore leaves every store unpublished',async()=>{
 const {emptyProjectData}=projectModule('./types');const local=emptyProjectData(),useProjects=store(local),usePlans=store({days:{}}),usePlansArchive=store({days:{}});for(const value of[useProjects,usePlans,usePlansArchive]){value.persist={hasHydrated:()=>true};value.setState=()=>assert.fail('must publish only after native success');}
 const api=await loadBackup({flushAllStorage:async()=>{},readJson:async key=>({state:key==='projects'?local:{days:{}},version:1}),getModule:async name=>name==='@/features/projects/store'?{useProjects,projectData:s=>s}:name==='@/features/projects/backup'?projectBackup:{usePlans,usePlansArchive},invoke:async command=>{assert.equal(command,'project_apply_remote_binding');throw new Error('STORAGE_CONFLICT');},acceptCommittedStorage:()=>assert.fail('failed transaction must not publish')});
 await assert.rejects(api.mergeBackup(backup({projects:{state:local,version:1}}),{overwriteSettings:false}),/STORAGE_CONFLICT/);assert.equal(useProjects.getState(),local);
});
test('invalid local archived references are validated before importing backup attachments',async()=>{
 const {emptyProjectData}=projectModule('./types');const local=emptyProjectData(),useProjects=store(local),usePlans=store({days:{}}),usePlansArchive=store({days:{}});for(const value of[useProjects,usePlans,usePlansArchive])value.persist={hasHydrated:()=>true};
 const api=await loadBackup({flushAllStorage:async()=>{},readJson:async key=>({state:key==='projects'?local:key==='plans-archive'?{days:{old:{tasks:[{id:'dangling',workItemId:'missing'}]}}}:{days:{}},version:1}),getModule:async name=>name==='@/features/projects/store'?{useProjects,projectData:s=>s}:name==='@/features/projects/backup'?projectBackup:{usePlans,usePlansArchive},invoke:()=>assert.fail('invalid graph must fail before writing attachments')});
 await assert.rejects(api.mergeBackup(backup({projects:{state:local,version:1},plans},[material]),{overwriteSettings:false}),/missing project task/);
});
