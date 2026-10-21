import test from 'node:test';
import assert from 'node:assert/strict';
import { addTags, filterItems, matchQuery, mcpNameProblem, removeTag, sizeLabel, timeLabel } from './core.ts';

test('搜索按多个词同时命中名字/描述/标签', () => {
  const items = [
    { name: 'SQL 优化', description: '索引与执行计划', tags: ['db'] },
    { name: 'Commit', description: '写提交信息', tags: ['git', 'db'] },
    { name: 'Rust', description: '类型与生命周期', tags: [] },
  ];
  assert.equal(filterItems(items, '').length, 3, '空查询返回全部');
  assert.deepEqual(filterItems(items, 'db').map((x) => x.name), ['SQL 优化', 'Commit'], '标签也参与匹配');
  assert.deepEqual(filterItems(items, 'db commit').map((x) => x.name), ['Commit'], '多个词必须同时命中');
  assert.deepEqual(filterItems(items, '  GIT  ').map((x) => x.name), ['Commit'], '大小写与多余空白不影响');
  assert.deepEqual(filterItems(items, '不存在'), []);
});

test('提示词走同一套匹配（字段名不同也不会有第二份实现）', () => {
  const prompt = { title: 'Review 代码', description: '逐行检查', tags: ['git'] };
  assert.equal(matchQuery('', [prompt.title, prompt.description, prompt.tags]), true);
  assert.equal(matchQuery('review git', [prompt.title, prompt.description, prompt.tags]), true);
  assert.equal(matchQuery('review git missing', [prompt.title, prompt.description, prompt.tags]), false);
});

test('标签增删：去空白、去重、中英文逗号都算分隔', () => {
  assert.deepEqual(addTags([], 'a, b，c\n d '), ['a', 'b', 'c', 'd']);
  assert.deepEqual(addTags(['a'], 'a, a'), ['a'], '重复的不再追加');
  assert.deepEqual(addTags(['a'], ' , , '), ['a'], '只有空白不该产生空标签');
  assert.deepEqual(removeTag(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(removeTag(['a'], 'z'), ['a']);
});

test('体积按 1024 进位且不进零', () => {
  assert.equal(sizeLabel(0), '0 B');
  assert.equal(sizeLabel(512), '512 B');
  assert.equal(sizeLabel(1024), '1.0 KB');
  assert.equal(sizeLabel(1536), '1.5 KB');
  assert.equal(sizeLabel(1024 * 1024), '1.0 MB');
  assert.equal(sizeLabel(Number.NaN), '0 B');
});

test('时间格式化对坏输入返回空串而不是 Invalid Date', () => {
  assert.equal(timeLabel('不是时间', 'zh'), '');
  assert.equal(timeLabel('', 'en'), '');
  assert.notEqual(timeLabel('2026-10-21T08:00:00Z', 'zh'), '');
});

test('MCP 名字里的分隔符会被挡下（别家工具的配置键不能带斜杠）', () => {
  assert.equal(mcpNameProblem(''), 'empty');
  assert.equal(mcpNameProblem('   '), 'empty');
  assert.equal(mcpNameProblem('a/b'), 'separator');
  assert.equal(mcpNameProblem('a\\b'), 'separator');
  assert.equal(mcpNameProblem('filesystem'), null);
});
