import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const nativeRequire = createRequire(import.meta.url);
function load(path, dependencies = {}) {
  const module = { exports: {} };
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(name => dependencies[name] ?? nativeRequire(name), module, module.exports);
  return module.exports;
}

test('legacy sticky records use accessible default arrow sizes without changing normal geometry', () => {
  const { stickyAppearance } = load('./sticky-presentation.ts');
  const legacy = { x: -800, y: 200, w: 333, h: 444, open: true };
  assert.deepEqual(stickyAppearance(legacy), { tabWidth: 112, tabHeight: 44 });
  assert.equal(legacy.w, 333);
  assert.deepEqual(stickyAppearance(null), { tabWidth: 112, tabHeight: 44 });
});

test('presentation accepts opaque hex colors and finite bounded logical pixel sizes', () => {
  const { stickyAppearance, stickyAppearancePatch } = load('./sticky-presentation.ts');
  assert.deepEqual(stickyAppearance({ stickyColor: ' #AA00fF ', tabWidth: 999, tabHeight: 1, previewWidth: 1200, previewHeight: 120 }), {
    stickyColor: '#aa00ff', tabWidth: 280, tabHeight: 40, previewWidth: 900, previewHeight: 240,
  });
  assert.deepEqual(stickyAppearancePatch({ stickyColor: 'transparent', tabWidth: NaN, tabHeight: Infinity, previewWidth: '400', x: 20 }), {});
  assert.deepEqual(stickyAppearancePatch({ stickyColor: undefined, previewWidth: undefined, tabHeight: 45.8 }), { stickyColor: undefined, previewWidth: undefined, tabHeight: 46 });
});

test('custom colors stay fully opaque with WCAG readable text across the palette', () => {
  const { stickyColorStyle } = load('./sticky-presentation.ts');
  const luminance = hex => {
    const channels = hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  for (const color of ['#000000', '#ffffff', '#808080', '#ff0000', '#0000ff', '#00ff00', '#bb88cc']) {
    const style = stickyColorStyle({ stickyColor: color });
    assert.equal(style.backgroundColor, color);
    const a = luminance(color), b = luminance(style.color);
    assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `${color} readable against ${style.color}`);
  }
  assert.deepEqual(stickyColorStyle({ stickyColor: 'url(unsafe)' }), {});
});

test('per-category and per-date settings preserve geometry, legacy fields and independent neighbors', () => {
  const helper = load('./sticky-presentation.ts');
  const storage = { tauriJsonStorage: { getItem: () => null, setItem: () => {} }, onStorageSynced: () => () => {} };
  const dependencies = { '@/lib/storage': storage, '@/features/desktop/sticky-presentation': helper,
    '@/features/files/directory-mapping-core': load('../files/directory-mapping-core.ts') };
  for (const [file, storeName, mapName, defaults] of [
    ['../../stores/files.ts', 'useFences', 'fences', 'DEFAULT_FENCE'],
    ['../../stores/papers.ts', 'usePapers', 'papers', 'DEFAULT_PAPER'],
  ]) {
    const module = load(file, dependencies), store = module[storeName];
    const a = { ...module[defaults], x: -900, w: 333, legacyExtra: 'keep', stickyColor: '#123456' }, b = { ...module[defaults], stickyColor: '#abcdef' };
    store.setState({ [mapName]: { a, b } });
    store.getState().setStickyAppearance('a', { stickyColor: '#FFEE00', tabWidth: 240, previewHeight: 800 });
    const updated = store.getState()[mapName];
    assert.deepEqual(updated.b, b);
    assert.deepEqual(updated.a, { ...a, stickyColor: '#ffee00', tabWidth: 240, previewHeight: 800 });
    store.getState().setStickyAppearance('a', { stickyColor: undefined, tabWidth: Infinity });
    assert.equal(store.getState()[mapName].a.stickyColor, undefined);
    assert.equal(store.getState()[mapName].a.tabWidth, 240);
    assert.equal(store.persist.getOptions().version, 1);
  }
});
