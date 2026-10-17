import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { cleanProvider, getProviderModels } from "../ai/core.ts";
import { collectAttachmentPaths, validateAttachmentFiles } from "./backup-files.ts";

const path = "modules/plans/tasks/task/attachments/file/example.bin";
const attachment = { id: "file", name: "example.bin", path, size: 3, createdAt: 1 };
const plans = { state: { days: { "2026-10-17": [{ id: "task", title: "Todo", attachments: [attachment] }] } }, version: 3 };
const material = { path, dataBase64: "AAEC" };
const source = await readFile(new URL("./backup.ts", import.meta.url), "utf8");
let sequence = 0;
async function loadBackup(dependencies) {
  const key = `__backupTest${++sequence}`;
  globalThis[key] = { cleanProvider, getProviderModels, collectAttachmentPaths, validateAttachmentFiles, ...dependencies };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText
    .replace(/^import[\s\S]*?from ["'][^"']+["'];\r?\n/gm, "")
    .replace(/import\("([^"]+)"\)/g, (_, name) => `getModule(${JSON.stringify(name)})`);
  const names = "pickBackupOpenPath,pickBackupSavePath,readBackup,readJson,restoreDirTree,scanDirTree,writeBackup,writeJson,flushAllStorage,useSettings,invoke,cleanProvider,getProviderModels,collectAttachmentPaths,validateAttachmentFiles,getModule";
  const module = await import(`data:text/javascript;base64,${Buffer.from(`const {${names}}=globalThis.${key};\n${code}`).toString("base64")}`);
  delete globalThis[key];
  return module;
}
function store(initial) {
  let state = initial;
  return { getState: () => state, setState: (patch) => { state = { ...state, ...patch }; } };
}
const backup = (data, files = []) => ({ kind: "nimbusdesk-backup", app: "nimbusdesk", schema: 2, exportedAt: "2026-10-17", data, attachments: files });

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
  const api = await loadBackup({
    readJson: async (key) => { read.push(key); return key === "plans" ? plans : key === "ai-providers" ? { state: { providers: [provider], llmApiKey: "also-removed" }, version: 1 } : null; },
    invoke: async (command, args) => { assert.equal(command, "task_attachments_export"); assert.deepEqual(args, { paths: [path] }); return [material]; },
  });
  const result = await api.buildBackup({ includeDirs: false });
  assert.deepEqual(read, api.BACKUP_KEYS);
  for (const key of ["todo-papers", "reminders", "favorites", "custom-feeds", "ai-providers", "knowledge-settings"]) assert.ok(read.includes(key));
  assert.ok(!read.includes("ai-settings"));
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

test("schema 1 stays readable, while incomplete schema 2 material fails before mutation", async () => {
  const api = await loadBackup({ invoke: () => assert.fail("must not write") });
  assert.equal(api.parseBackup(JSON.stringify({ ...backup({}), schema: 1, attachments: undefined })).schema, 1);
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
  const usePapers = store({ papers: { today: { pinned: true } }, order: ["today"] });
  const useReminderSettings = store({ enabled: true, advance: 10, notified: ["local"] });
  const useSettings = store({ theme: "dark", dataDir: "local" });
  const modules = {
    "@/features/plans/store": { usePlans }, "@/stores/favorites": { useFavorites }, "@/stores/custom-feeds": { useCustomFeeds },
    "@/stores/papers": { usePapers }, "@/stores/reminders": { useReminderSettings },
  };
  const api = await loadBackup({ useSettings, getModule: async (name) => modules[name], invoke: async (command, args) => {
    assert.equal(command, "task_attachments_import"); assert.deepEqual(args, { files: [material] }); events.push("files");
  } });
  await api.mergeBackup(backup({ plans, settings: { theme: "light" }, favorites: { items: [{ id: "new", url: "new" }] }, "custom-feeds": { feeds: [{ id: "same", name: "incoming" }, { id: "extra" }] }, "todo-papers": { papers: { today: { pinned: false }, tomorrow: { pinned: true } }, order: ["tomorrow"] }, reminders: { enabled: false, advance: 0, notified: ["incoming"] } }, [material]), { overwriteSettings: false });
  assert.deepEqual(events, ["files", "tasks"]);
  assert.equal(usePlans.getState().days["2026-10-17"][0].attachments[0].path, path);
  assert.equal(useSettings.getState().theme, "dark");
  assert.equal(useCustomFeeds.getState().feeds[0].name, "local");
  assert.equal(usePapers.getState().papers.today.pinned, true);
  assert.deepEqual(usePapers.getState().order, ["today", "tomorrow"]);
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
