import test from 'node:test';
import assert from 'node:assert/strict';
import { addTags, bodyOf, collapseContext, collectTags, diffLines, diffStat, filterItems, formatPairs, matchQuery, matchTags, mcpEntry, mcpExport, mcpNameProblem, parseMcpJson, parsePairs, removeTag, sizeLabel, timeLabel } from './core.ts';

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

test('键值对文本按第一个等号切分，注释与空行被忽略', () => {
  assert.deepEqual(parsePairs('# 注释\n\nFOO=bar\nURL=https://x?a=1&b=2\n空行= 值  '), {
    FOO: 'bar',
    URL: 'https://x?a=1&b=2',
    空行: '值',
  });
  assert.deepEqual(parsePairs('没有等号\n=没有键'), {}, '坏行整条跳过而不是塞进门面');
  assert.equal(formatPairs({ B: '2', A: '1' }), 'A=1\nB=2', '按键入排序便于比对');
  assert.equal(parsePairs(formatPairs({ K: 'v=1' })).K, 'v=1', '往返不丢值里的等号');
  assert.deepEqual(formatPairs({}), '');
});

test('标签筛选：或=命中任意一个，与=必须全部命中', () => {
  const tags = ['git', 'db'];
  assert.equal(matchTags(tags, new Set(), 'or'), true, '没选标签全通过');
  assert.equal(matchTags(tags, new Set(['db', 'rust']), 'or'), true);
  assert.equal(matchTags(tags, new Set(['db', 'rust']), 'and'), false);
  assert.equal(matchTags(tags, new Set(['git', 'db']), 'and'), true);
  assert.equal(matchTags([], new Set(['db']), 'or'), false);
});

test('标签清单按使用次数降序，同次数按名字稳定排序', () => {
  const { tags, counts } = collectTags([{ tags: ['b', 'a'] }, { tags: ['a', 'c'] }, { tags: ['a'] }]);
  assert.deepEqual(tags, ['a', 'b', 'c']);
  assert.deepEqual(counts, { a: 3, b: 1, c: 1 });
  assert.deepEqual(collectTags([]), { tags: [], counts: {} });
});

test('行级 diff 标出增删，相同行保持顺序', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nx\nc'), [
    { type: 'same', text: 'a' },
    { type: 'del', text: 'b' },
    { type: 'add', text: 'x' },
    { type: 'same', text: 'c' },
  ]);
  assert.deepEqual(diffLines('', 'new'), [{ type: 'add', text: 'new' }], '空内容不该凭空多一行');
  assert.deepEqual(diffLines('gone', ''), [{ type: 'del', text: 'gone' }]);
  assert.deepEqual(diffLines('same', 'same'), [{ type: 'same', text: 'same' }]);
  assert.deepEqual(diffStat(diffLines('a\nb', 'a\nc\nb')), { added: 1, removed: 0 });
});

test('纯增删的 diff 不被折叠成省略号（否则点开什么也看不到）', () => {
  const rows = diffLines('', 'l1\nl2\nl3\nl4\nl5\nl6');
  assert.equal(collapseContext(rows).some((r) => r.type === 'gap'), false);
  const lines = Array.from({ length: 12 }, (_, i) => 'l' + i).join('\n');
  const changed = lines.replace('l2', 'X').replace('l9', 'Y');
  assert.equal(collapseContext(diffLines(lines, changed)).some((r) => r.type === 'gap'), true, '两处改动之间的长段相同内容要折叠');
});

test('版本比对前剥掉 frontmatter，正文一样就不算脏', () => {
  const fm = '---\nname: a\n---\n\n正文';
  assert.equal(bodyOf(fm), '正文');
  assert.equal(bodyOf('正文'), '正文', '没有 frontmatter 时原样返回');
  assert.equal(bodyOf('---\r\nname: a\r\n---\r\n\r\n正文'), '正文', 'CRLF 也要剥掉');
});

test('MCP 导出的条目形状与 Rust 侧逐字段一致（空 env/headers 也照发）', () => {
  const stdio = { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: {}, url: '', headers: {} };
  const http = { name: 'remote', transport: 'sse', command: '', args: [], env: {}, url: 'https://a/mcp', headers: { Authorization: 'Bearer t' } };
  assert.deepEqual(mcpEntry(stdio), { command: 'npx', args: ['-y', 'x'], env: {} });
  assert.deepEqual(mcpEntry(http), { type: 'sse', url: 'https://a/mcp', headers: { Authorization: 'Bearer t' } });
  assert.deepEqual(mcpExport([stdio, http]), {
    mcpServers: {
      fs: { command: 'npx', args: ['-y', 'x'], env: {} },
      remote: { type: 'sse', url: 'https://a/mcp', headers: { Authorization: 'Bearer t' } },
    },
  });
  assert.deepEqual(mcpExport([{ ...stdio, name: '  ' }]), { mcpServers: {} }, '没有名字的条目会被别的工具写坏配置');
});

test('MCP JSON 导入认四种包装，坏 JSON 不抛异常', () => {
  const single = '{"mcpServers":{"fs":{"command":"npx","args":["-y","x"],"env":{"K":"v"}}}}';
  assert.deepEqual(parseMcpJson(single), [
    { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { K: 'v' }, url: '', headers: {} },
  ]);
  assert.equal(parseMcpJson('{"servers":{"a":{"type":"stdio","command":"node"}}}')[0].name, 'a', 'VS Code 的 servers');
  assert.deepEqual(parseMcpJson('{"mcp":{"b":{"type":"remote","url":"https://x","headers":{"A":"1"}}}}'), [
    { name: 'b', transport: 'http', command: '', args: [], env: {}, url: 'https://x', headers: { A: '1' } },
  ], 'OpenCode 的 mcp + remote');
  assert.deepEqual(parseMcpJson('{"c":{"type":"local","command":["node","server.js"],"environment":{"K":"v"}}}'), [
    { name: 'c', transport: 'stdio', command: 'node', args: ['server.js'], env: { K: 'v' }, url: '', headers: {} },
  ], '裸映射 + 数组式 command + environment');
  assert.deepEqual(parseMcpJson('不是 JSON'), []);
  assert.deepEqual(parseMcpJson('[]'), []);
  assert.deepEqual(parseMcpJson('{"mcpServers":{"bad":123}}'), [], '条目不是对象就整条丢掉');
});
