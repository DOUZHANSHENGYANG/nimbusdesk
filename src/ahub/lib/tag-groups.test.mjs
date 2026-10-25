import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const nativeRequire = createRequire(import.meta.url), cache = new Map();
function load(name = './tag-groups') {
  if (cache.has(name)) return cache.get(name).exports;
  const code = ts.transpileModule(readFileSync(new URL(`${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const m = { exports: {} };
  cache.set(name, m);
  new Function('require', 'module', 'exports', code)((s) => (s.startsWith('.') ? load(s) : nativeRequire(s)), m, m.exports);
  return m.exports;
}
const tags = load();

const groups = [
  { id: 'g1', name: '领域', tags: ['代码', '设计'] },
  { id: 'g2', name: '阶段', tags: ['审查'] },
];

test('tags split into their groups, leftovers go to ungrouped', () => {
  const out = tags.groupTags(['代码', '设计', '审查', '运维'], groups);
  assert.deepEqual(out.groups.map((g) => g.tags), [['代码', '设计'], ['审查']]);
  assert.deepEqual(out.ungrouped, ['运维']);
});

test('vanished tags are ignored and a tag lives in one group only', () => {
  const out = tags.groupTags(['代码', '审查'], [
    { id: 'g1', name: '领域', tags: ['代码', '审查', '已经不存在的标签'] },
    { id: 'g2', name: '阶段', tags: ['审查'] },
  ]);
  assert.deepEqual(out.groups[0].tags, ['代码', '审查']);
  assert.deepEqual(out.groups[1].tags, []);
  assert.deepEqual(out.ungrouped, []);
});

test('assigning moves a tag between groups and can take it out', () => {
  const moved = tags.assignTag(groups, '代码', 'g2');
  assert.deepEqual(moved[0].tags, ['设计']);
  assert.deepEqual(moved[1].tags, ['审查', '代码']);

  const out = tags.assignTag(groups, '代码', null);
  assert.deepEqual(out[0].tags, ['设计']);
  assert.deepEqual(out[1].tags, ['审查']);
});

test('removing a group returns its tags to ungrouped instead of dropping them', () => {
  const left = tags.removeGroup(groups, 'g2');
  assert.equal(left.length, 1);
  const view = tags.groupTags(['代码', '设计', '审查'], left);
  assert.deepEqual(view.ungrouped, ['审查']);
});

test('names are trimmed and an empty rename is ignored', () => {
  assert.equal(tags.renameGroup(groups, 'g1', '  技术栈 ')[0].name, '技术栈');
  assert.equal(tags.renameGroup(groups, 'g1', '   ')[0].name, '领域');
});

test('prune drops tags that no longer exist anywhere', () => {
  const pruned = tags.pruneGroups(groups, ['代码']);
  assert.deepEqual(pruned.map((g) => g.tags), [['代码'], []]);
});
