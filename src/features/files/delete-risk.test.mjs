import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

let sequence = 0;
async function load(path, dependencies = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const key = `__riskTest${++sequence}`;
  const code = ts
    .transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
    .outputText.replace(/^import[\s\S]*?;\s*/gm, '');
  globalThis[key] = dependencies;
  try {
    return await import(
      `data:text/javascript;base64,${Buffer.from(`const {${Object.keys(dependencies).join(',')}}=globalThis.${key};\n${code}`).toString('base64')}`
    );
  } finally {
    delete globalThis[key];
  }
}

test('a small single file stays low risk so the dialog does not cry wolf', async () => {
  const { assessDeleteRisk } = await load('./delete-risk.ts', {});
  const risk = assessDeleteRisk([{ kind: 'file', size: 3 * 1024 }]);
  assert.equal(risk.severity, 'low');
  assert.equal(risk.bytes, 3 * 1024);
  assert.equal(risk.hasFolder, false);
  assert.equal(risk.localCount, 1);
});

test('a folder is always high risk because its contents are invisible', async () => {
  const { assessDeleteRisk } = await load('./delete-risk.ts', {});
  const risk = assessDeleteRisk([{ kind: 'folder', size: null }]);
  assert.equal(risk.severity, 'high');
  assert.equal(risk.hasFolder, true);
});

test('a file at or over the size threshold is high risk', async () => {
  const { assessDeleteRisk, BIG_BYTES } = await load('./delete-risk.ts', {});
  assert.equal(assessDeleteRisk([{ kind: 'file', size: BIG_BYTES - 1 }]).severity, 'low');
  assert.equal(assessDeleteRisk([{ kind: 'file', size: BIG_BYTES }]).severity, 'high');
});

test('a batch at or over the item threshold is high risk even when every file is tiny', async () => {
  const { assessDeleteRisk, BATCH_LIMIT } = await load('./delete-risk.ts', {});
  const files = (n) => Array.from({ length: n }, () => ({ kind: 'file', size: 1 }));
  assert.equal(assessDeleteRisk(files(BATCH_LIMIT - 1)).severity, 'low');
  assert.equal(assessDeleteRisk(files(BATCH_LIMIT)).severity, 'high');
});

test('web links do not count toward deletion risk', async () => {
  const { assessDeleteRisk } = await load('./delete-risk.ts', {});
  const risk = assessDeleteRisk([
    { kind: 'url' },
    { kind: 'url' },
    { kind: 'url' },
    { kind: 'url' },
    { kind: 'url' },
  ]);
  assert.equal(risk.localCount, 0);
  assert.equal(risk.bytes, 0);
  assert.equal(risk.severity, 'low', 'five removed bookmarks must not look like a mass delete');
});

test('an unknown size is reported but does not fake a large delete', async () => {
  const { assessDeleteRisk } = await load('./delete-risk.ts', {});
  const risk = assessDeleteRisk([{ kind: 'file', size: null }]);
  assert.equal(risk.unknownSize, true);
  assert.equal(risk.severity, 'low');
  assert.equal(risk.bytes, 0);
});

test('formatBytes stays readable across units', async () => {
  const { formatBytes } = await load('./delete-risk.ts', {});
  assert.equal(formatBytes(0), '');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2.0 GB');
});
