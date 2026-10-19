import assert from "node:assert/strict";
import test from "node:test";
import { readTags, withTags, tagsFromContent, inferTags } from "./metadata.ts";

test("tags read YAML arrays, block lists and strings without duplicate hashes", () => {
  assert.deepEqual(readTags('tags: [Vue, "#前端", Vue]\ncreated: 2026-10-17\n'), ["Vue", "前端"]);
  assert.deepEqual(readTags('tags:\n  - TypeScript\n  - 工具\n'), ["TypeScript", "工具"]);
  assert.deepEqual(readTags('tags: Oracle\n'), ["Oracle"]);
});
test("tag insertion preserves BOM, CRLF, comments, other properties and exact body", () => {
  const content = '\ufeff---\r\ntype: 技术知识 # 原注释\r\ntags: [] # 标签注释\r\ncreated: 2020-01-01\r\n---\r\n\r\n# 原标题\r\n正文原样';
  const result = withTags(content, ["Oracle", "SQL"], true);
  assert.equal(result, content.replace('tags: []', 'tags: ["Oracle","SQL"]'));
  assert.deepEqual(tagsFromContent(result), ["Oracle", "SQL"]);
  assert.equal(withTags(result, ["覆盖"], true), result);
});
test("missing and null tags are filled but malformed frontmatter is rejected", () => {
  for (const content of ['# 标题\n\n正文', '---\ntype: 技术\n---\n# 标题', '---\ntags:\ntype: 技术\n---\n# 标题']) {
    const updated = withTags(content, ["Git"], true);
    assert.deepEqual(tagsFromContent(updated), ["Git"]);
    assert.ok(updated.endsWith(content.split('---\n').pop()));
  }
  assert.throws(() => withTags('---\ntags: [broken\n---\nbody', ["AI"], true));
});
test("local topic suggestions identify actual technology and intent", () => {
  const tags = inferTags('01-技术/03-技术栈/Oracle11g实践/Oracle 连接排错.md', '# Oracle 连接排错\n检查 SQLPlus 和数据库连接。');
  assert.ok(tags.includes("Oracle"));
  assert.ok(tags.includes("排错"));
  assert.equal(tags.includes("未分类"), false);
});
test("editing a block tag list keeps the next property on its own line", () => {
  const updated = withTags('---\ntags:\n  - Old\ncreated: 2020-01-01\n---\nBody', ["New"]);
  assert.deepEqual(tagsFromContent(updated), ["New"]);
  assert.match(updated, /\ncreated: 2020-01-01\n/);
});
test("a project folder name is never guessed from the path", () => {
  // Only the managed folders and the inbox are scanned, so a project directory
  // cannot reach this code. The old guess produced a tag no project row backed;
  // linking a note to a work item is the supported path instead.
  assert.equal(inferTags("06-项目研究/云台/搜索设计.md", "# 搜索设计\n正文").includes("项目研究"), false);
  // A topic match keeps the last-resort folder fallback out of the result, so the
  // only way "云台" could appear here was the removed project-directory rule.
  const tags = inferTags("06-项目研究/云台/Oracle 排错.md", "# Oracle 排错\n检查 SQLPlus 连接。");
  assert.ok(tags.includes("Oracle"));
  assert.equal(tags.includes("云台"), false);
});
