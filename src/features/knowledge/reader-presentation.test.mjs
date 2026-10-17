import test from 'node:test';
import assert from 'node:assert/strict';
import { previewWithoutRepeatedTitle } from './reader-presentation.ts';

test('preview omits only the matching leading title and preserves frontmatter/source content', () => {
  const content = '---\r\ntags: [开发]\r\n---\r\n\r\n# 端口排查\r\n\r\n## 操作\r\n\r\n正文';
  const output = previewWithoutRepeatedTitle(content, '端口排查');
  assert.equal(output, '---\r\ntags: [开发]\r\n---\r\n\r\n## 操作\r\n\r\n正文');
  assert.ok(content.includes('# 端口排查'), 'original is unchanged');
});
test('preview retains different titles, later headings and code blocks', () => {
  for (const source of ['# 另一篇\n\n正文', '前言\n\n# 端口排查', '```md\n# 端口排查\n```', '    # 端口排查', '\t# 端口排查', '---\ntags: [broken\n# 端口排查']) {
    assert.equal(previewWithoutRepeatedTitle(source, '端口排查'), source);
  }
});
