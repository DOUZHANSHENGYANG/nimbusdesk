import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function loadGeometry() {
  const source = await readFile(new URL("./capsule-window.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText.replace(/^import .*;\r?\n/gm, "");
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const pending = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const native = { outerPosition: async () => ({ x: -450, y: 300 }), innerSize: async () => ({ width: 450, height: 570 }), scaleFactor: async () => 1.5 };

test("paper geometry uses logical units and collapsed height does not replace expanded height", async () => {
  const { normalPaperGeometry } = await loadGeometry();
  assert.equal(typeof normalPaperGeometry, "function", "normal paper geometry needs a guarded snapshot");
  assert.deepEqual(await normalPaperGeometry(native, () => ({ active: true, collapsed: false })), { x: -300, y: 200, w: 300, h: 380 });
  assert.deepEqual(await normalPaperGeometry(native, () => ({ active: true, collapsed: true })), { x: -300, y: 200, w: 300 });
});

test("an asynchronous paper snapshot cannot overwrite geometry after docking or a collapse transition", async () => {
  const { normalPaperGeometry } = await loadGeometry();
  assert.equal(typeof normalPaperGeometry, "function", "normal paper geometry needs a guarded snapshot");
  const size = pending();
  let state = { active: true, collapsed: false };
  const snapshot = normalPaperGeometry({ ...native, innerSize: () => size.promise }, () => state);
  state = { active: false, collapsed: false };
  size.resolve({ width: 24, height: 64 });
  assert.equal(await snapshot, null);
  const nextSize = pending();
  state = { active: true, collapsed: false };
  const nextSnapshot = normalPaperGeometry({ ...native, innerSize: () => nextSize.promise }, () => state);
  state = { active: true, collapsed: true };
  nextSize.resolve({ width: 300, height: 116 });
  assert.equal(await nextSnapshot, null);
});

test("edge task preview tolerates malformed duplicate and cyclic task identifiers", async () => {
  const types = await readFile(new URL("./types.ts", import.meta.url), "utf8");
  const compile = (source) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  const typesUrl = `data:text/javascript;base64,${Buffer.from(compile(types)).toString("base64")}`;
  const source = await readFile(new URL("./capsule.ts", import.meta.url), "utf8");
  const code = compile(source).replace(/from "@\/features\/plans\/types"/, `from "${typesUrl}"`);
  const { flattenTree } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const row = (id, parentId) => ({ id, parentId, title: id, done: false, createdAt: 1, updatedAt: 1 });
  const tasks = [row("parent", null), row("child", "parent"), row("parent", "child")];
  assert.deepEqual(flattenTree(tasks).map(({ task, depth }) => [task.id, depth]), [["parent", 0], ["child", 1]]);
});
