import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const native = createRequire(import.meta.url);
function load(file) {
  if (!existsSync(new URL(file, import.meta.url))) return {};
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(native, module, module.exports);
  return module.exports;
}

test('box appearance defaults mirror the current fence look', () => {
  const { boxAppearance, DEFAULT_BOX_APPEARANCE } = load('./box-appearance.ts');
  assert.deepEqual(boxAppearance(undefined), DEFAULT_BOX_APPEARANCE);
  assert.equal(boxAppearance(undefined).iconSize, 44);
  assert.equal(boxAppearance(undefined).radius, 16);
});

test('bad values fall back and numeric values clamp into the documented ranges', () => {
  const { boxAppearance } = load('./box-appearance.ts');
  const value = boxAppearance({ iconSize: 999, fontSize: 1, backgroundAlpha: -4, radius: 90, view: 'grid', nameMode: 'weird' });
  assert.equal(value.iconSize, 72);
  assert.equal(value.fontSize, 8);
  assert.equal(value.backgroundAlpha, 0.45);
  assert.equal(value.radius, 28);
  assert.equal(value.view, 'icons');
  assert.equal(value.nameMode, 'full');
});

test('incremental patches only accept known keys and can reset to defaults', () => {
  const { boxAppearancePatch, DEFAULT_BOX_APPEARANCE } = load('./box-appearance.ts');
  assert.deepEqual(boxAppearancePatch({ iconSize: 42, view: 'list', unknown: 1 }), { iconSize: 42, view: 'list' });
  assert.deepEqual(boxAppearancePatch({ iconSize: undefined }), { iconSize: DEFAULT_BOX_APPEARANCE.iconSize });
  assert.deepEqual(boxAppearancePatch(null), {});
});

test('display names follow full / noExt / extOnly / none without touching the file', () => {
  const { boxDisplayName } = load('./box-appearance.ts');
  assert.equal(boxDisplayName('report.final.PDF', 'full'), 'report.final.PDF');
  assert.equal(boxDisplayName('report.final.PDF', 'noExt'), 'report.final');
  assert.equal(boxDisplayName('report.final.PDF', 'extOnly'), 'PDF');
  assert.equal(boxDisplayName('report.final.PDF', 'none'), '');
  assert.equal(boxDisplayName('README', 'noExt'), 'README');
});
