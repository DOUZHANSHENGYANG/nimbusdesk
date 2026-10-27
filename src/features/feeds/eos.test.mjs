import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

let sequence = 0;
async function load(path, dependencies = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const key = `__eosTest${++sequence}`;
  const code = ts
    .transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
    .outputText.replace(/^import[\s\S]*?;\s*/gm, '');
  globalThis[key] = dependencies;
  try {
    return await import(
      `data:text/javascript;base64,${Buffer.from(
        `const {${Object.keys(dependencies).join(',')}}=globalThis.${key};\n${code}`,
      ).toString('base64')}`
    );
  } finally {
    delete globalThis[key];
  }
}

const rule = { id: 'r1', title: '测试站', group: '测试', url: 'https://site.test/s?q={keyword}', yield: 0 };

/* ── URL 模板 ─────────────────────────────────────────── */

test('buildEosUrl replaces every {keyword} and encodes it', async () => {
  const { buildEosUrl } = await load('../../search/eos/rule.ts', { bundle: { rules: [] } });
  assert.equal(
    buildEosUrl({ ...rule, url: 'https://site.test/s?q={keyword}&p=2' }, '三体 全集'),
    'https://site.test/s?q=%E4%B8%89%E4%BD%93%20%E5%85%A8%E9%9B%86&p=2',
  );
  // 占位符在 JSON 数组参数里（动漫花园那种写法）也必须能替换
  assert.equal(
    buildEosUrl({ ...rule, url: 'https://g.test/r/1?search=["{keyword}"]' }, 'a b'),
    'https://g.test/r/1?search=["a%20b"]',
  );
});

/* ── 抽取 ─────────────────────────────────────────────── */

test('extractHits keeps detail links and drops navigation, beian and legal hosts', async () => {
  const { extractHits } = await load('../../search/eos/extract.ts', {});
  const html = `
    <a href="/">首页</a>
    <a href="/about">关于我们</a>
    <a href="https://site.test/question/12345.html">三体 三部曲里那些细思极恐的悬念</a>
    <a href="https://site.test/question/99999.html">三体 讲的是什么内容</a>
    <a href="https://site.test/question/88888.html">完全不相关的另一篇文章标题</a>
    <a href="https://beian.mps.gov.cn/x">陕公网安备 1011202001080 号</a>
    <a href="javascript:void(0)">三体 下载</a>
    <a href="#">三体 回到顶部</a>
  `;
  const hits = extractHits(html, 'https://site.test/s?q=三体', '三体', rule);
  assert.deepEqual(hits.map(h => h.url), [
    'https://site.test/question/12345.html',
    'https://site.test/question/99999.html',
  ]);
  // 关键词与 URL 都不含它的链接是站内推荐位，不是搜索结果
  assert.equal(hits.some(h => h.url.endsWith('88888.html')), false);
});

test('extractHits deduplicates the same path with different tracking queries', async () => {
  const { extractHits } = await load('../../search/eos/extract.ts', {});
  const html = `
    <a href="/p/1?utm=a">三体 第一章</a>
    <a href="/p/1?utm=b">三体 第一章（另一条追踪链接）</a>
  `;
  assert.equal(extractHits(html, 'https://site.test/s?q=三体', '三体', rule).length, 1);
});

test('extractHits ignores script and style contents', async () => {
  const { extractHits } = await load('../../search/eos/extract.ts', {});
  const html = `
    <script>var s = '<a href="/p/9">三体 脚本里的假链接</a>';</script>
    <style>/* <a href="/p/8">三体 样式里的假链接</a> */</style>
    <a href="/p/7">三体 真链接</a>
  `;
  assert.deepEqual(extractHits(html, 'https://site.test/s?q=三体', '三体', rule).map(h => h.url), [
    'https://site.test/p/7',
  ]);
});

test('extractResources finds magnet, ed2k and pan links', async () => {
  const { extractResources } = await load('../../search/eos/extract.ts', {});
  const html = `
    <a href="magnet:?xt=urn:btih:ABCDEF123456">磁力</a>
    <a href="ed2k://|file|movie.mkv|123|ABCD|/">电驴</a>
    <a href="https://pan.quark.cn/s/abc123">夸克</a>
    <script>var x = "magnet:?xt=urn:btih:SHOULDNOTCOUNT";</script>
  `;
  const found = extractResources(html).map(r => r.url);
  assert.equal(found.some(u => u.startsWith('magnet:')), true);
  assert.equal(found.some(u => u.startsWith('ed2k:')), true);
  assert.equal(found.some(u => u.includes('pan.quark.cn')), true);
  assert.equal(found.some(u => u.includes('SHOULDNOTCOUNT')), false, 'script contents must be stripped first');
});

test('extractResources only keeps links whose surroundings mention the keyword', async () => {
  const { extractResources } = await load('../../search/eos/extract.ts', {});
  const html = `
    <div class="hot"><a href="https://www.aliyundrive.com/s/UNRELATED1">热门资源 A</a></div>
    <div class="result"><a href="https://www.aliyundrive.com/s/MATCHED2"><h2 class="title">510_深入浅出搞定 React</h2></a></div>
  `;
  // 不带关键词：两条都收（调用方明确要全部时）
  assert.equal(extractResources(html).length, 2);
  // 带关键词：只剩上下文里提到 react 的那条
  const filtered = extractResources(html, 'react');
  assert.deepEqual(filtered.map(r => r.url), ['https://www.aliyundrive.com/s/MATCHED2']);
  // 标题取锚点里的 h2，而不是 URL
  assert.equal(filtered[0].label, '510_深入浅出搞定 React');
});

/* ── 关键词匹配与噪音过滤 ─────────────────────────────── */

test('ASCII keywords match whole words so React does not match Reactor', async () => {
  const { matchesKeyword } = await load('../../search/eos/extract.ts', {});
  assert.equal(matchesKeyword('React 18 发布', 'react'), true);
  assert.equal(matchesKeyword('在react项目中跑jest', 'react'), true);
  assert.equal(matchesKeyword('Chain React Pro 单人游戏', 'react'), true);
  assert.equal(matchesKeyword('Reactor2', 'react'), false);
  assert.equal(matchesKeyword('Reactive streams', 'react'), false);
  assert.equal(matchesKeyword('react-native 教程', 'react'), true);
  // 中文没有词边界，按子串走
  assert.equal(matchesKeyword('三体 动画', '三体'), true);
  assert.equal(matchesKeyword('流浪地球', '三体'), false);
});

test('extractHits drops direct installer links', async () => {
  const { extractHits } = await load('../../search/eos/extract.ts', {});
  const html = `
    <a href="https://syly.test/upload/game_package2181.apk">安卓下载</a>
    <a href="https://site.test/setup.exe">React 桌面版安装包</a>
    <a href="https://site.test/p/1">React 18 的新特性</a>
  `;
  const hits = extractHits(html, 'https://site.test/s?q=react', 'react', rule);
  assert.deepEqual(hits.map(h => h.url), ['https://site.test/p/1']);
});

test('extractHits drops site search widgets', async () => {
  const { extractHits } = await load('../../search/eos/extract.ts', {});
  const html = `
    <a href="https://cse.google.com/cse?cx=1&amp;q=react">使用“Google”搜本站</a>
    <a href="https://site.test/p/1">React 18 的新特性</a>
  `;
  assert.deepEqual(extractHits(html, 'https://site.test/s?q=react', 'react', rule).map(h => h.url), [
    'https://site.test/p/1',
  ]);
});

/* ── 健康度：失败自动失效 ─────────────────────────────── */

test('a rule cools down after repeated failures and revives after the window', async () => {
  const { isCooling, FAIL_LIMIT, COOLDOWN_MS } = await load('../../search/eos/health.ts', {
    create: () => () => ({}),
    persist: (fn) => fn,
    createJSONStorage: () => () => ({}),
    tauriJsonStorage: {},
  });
  const now = 1_000_000_000_000;
  assert.equal(isCooling({ fails: 0 }, now), false);
  assert.equal(isCooling({ fails: FAIL_LIMIT - 1, failedAt: now }, now), false, 'below the limit stays usable');
  assert.equal(isCooling({ fails: FAIL_LIMIT, failedAt: now }, now), true);
  assert.equal(isCooling({ fails: FAIL_LIMIT, failedAt: now }, now + COOLDOWN_MS + 1), false, 'window expires');
});

test('rankRules drops cooling rules and puts proven ones first', async () => {
  const { rankRules } = await load('../../search/eos/health.ts', {
    create: () => () => ({}),
    persist: (fn) => fn,
    createJSONStorage: () => () => ({}),
    tauriJsonStorage: {},
  });
  const now = Date.now();
  const rules = [
    { id: 'never-tried', yield: 0 },
    { id: 'proven', yield: 0 },
    { id: 'dead', yield: 50 },
    { id: 'bundled-good', yield: 12 },
  ];
  const health = {
    proven: { fails: 0, okAt: now, hits: 30 },
    dead: { fails: 5, failedAt: now },
  };
  assert.deepEqual(rankRules(rules, health, now).map(r => r.id), ['proven', 'bundled-good', 'never-tried']);
});

test('a single day-old failure streak decays instead of blacklisting forever', async () => {
  const { rankRules } = await load('../../search/eos/health.ts', {
    create: () => () => ({}),
    persist: (fn) => fn,
    createJSONStorage: () => () => ({}),
    tauriJsonStorage: {},
  });
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  // 两连败，但都发生在前天：衰减后 fails 归 0，应该重新可用
  const health = { stale: { fails: 2, failedAt: now - 2 * day } };
  assert.deepEqual(rankRules([{ id: 'stale', yield: 3 }], health, now).map(r => r.id), ['stale']);
});

/* ── 内置规则表 ───────────────────────────────────────── */

test('bundled rules are all usable templates and carry no cookies', async () => {
  const raw = JSON.parse(await readFile(new URL('../../search/eos/rules.json', import.meta.url), 'utf8'));
  assert.ok(raw.rules.length > 150, `expected a full snapshot, got ${raw.rules.length}`);
  for (const r of raw.rules) {
    assert.ok(r.url.includes('{keyword}'), `${r.title} has no placeholder`);
    assert.equal('cookie' in r, false, `${r.title} must not ship a cookie`);
    assert.ok(r.group && r.title && r.id);
  }
  // 去重：上游同一个站点可能被重复收录
  const ids = raw.rules.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, 'rule ids must be unique');
});
