import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function load() {
  const source = await readFile(new URL('./display-name.ts', import.meta.url), 'utf8');
  const code = ts
    .transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
    .outputText.replace(/^import[\s\S]*?;\s*/gm, '');
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

test('full mode is the identity', async () => {
  const { displayName } = await load();
  assert.equal(displayName('季度报告.docx', 'full'), '季度报告.docx');
});

test('noExt mode drops only the last extension', async () => {
  const { displayName } = await load();
  assert.equal(displayName('季度报告.docx', 'noExt'), '季度报告');
  // 多点文件名只切最后一段，保留 archive.tar
  assert.equal(displayName('archive.tar.gz', 'noExt'), 'archive.tar');
  assert.equal(displayName('无扩展名', 'noExt'), '无扩展名');
});

test('extOnly mode keeps just the extension', async () => {
  const { displayName } = await load();
  assert.equal(displayName('季度报告.docx', 'extOnly'), 'docx');
});

test('dotfiles and trailing dots are not treated as extensions', async () => {
  const { displayName } = await load();
  assert.equal(displayName('.gitignore', 'noExt'), '.gitignore', '点开头不是扩展名');
  assert.equal(displayName('名字.', 'noExt'), '名字.', '点结尾不是扩展名');
  assert.equal(displayName('.gitignore', 'extOnly'), '.gitignore');
});

test('folders and names with spaces keep working', async () => {
  const { displayName } = await load();
  assert.equal(displayName('工作项目 v2', 'noExt'), '工作项目 v2');
  assert.equal(displayName('会议 记录 2026.md', 'noExt'), '会议 记录 2026');
});
