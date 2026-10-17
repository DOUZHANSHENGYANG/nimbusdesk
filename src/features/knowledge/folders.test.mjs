import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_KNOWLEDGE_FOLDERS, vaultKey, normalizeFolders, folderWithinVault, foldersForVault } from './folders.ts';

test('existing paths stay default and each vault keeps its own bindings', () => {
  assert.deepEqual(foldersForVault({}, 'E:/vault'), DEFAULT_KNOWLEDGE_FOLDERS);
  const custom={experience:'团队/经验',recipe:'团队/配方',resource:'资料/收藏'};
  assert.deepEqual(foldersForVault({[vaultKey('E:\\vault\\')]:custom},'e:/VAULT'),custom);
  assert.deepEqual(foldersForVault({[vaultKey('E:/vault')]:custom},'E:/other'),DEFAULT_KNOWLEDGE_FOLDERS);
});
test('normalize editable vault-relative folders and reject overlap or protected scopes', () => {
  assert.deepEqual(normalizeFolders({experience:'团队\\经验/',recipe:'团队/配方',resource:'资料/收藏'}),{experience:'团队/经验',recipe:'团队/配方',resource:'资料/收藏'});
  for (const experience of ['', '../outside','E:/absolute','.obsidian','assets/images','08-收件箱','bad/../name','team/CON','team/name.','team/node_modules']) {
    assert.throws(()=>normalizeFolders({...DEFAULT_KNOWLEDGE_FOLDERS,experience}));
  }
  assert.throws(()=>normalizeFolders({experience:'Team',recipe:'team/recipes',resource:'资源'}));
  assert.equal(normalizeFolders({...DEFAULT_KNOWLEDGE_FOLDERS,experience:'资料/命名.md'}).experience,'资料/命名.md');
});
test('folder picker converts only a child of this vault, including Windows canonical paths', () => {
  assert.equal(folderWithinVault('E:\\User\\knowledge-base','E:\\User\\knowledge-base\\团队\\经验'),'团队/经验');
  assert.equal(folderWithinVault('\\\\?\\E:\\User\\knowledge-base','e:/User/knowledge-base/资料/收藏'),'资料/收藏');
  assert.throws(()=>folderWithinVault('E:/vault','E:/vault-extra/folder'));
  assert.throws(()=>folderWithinVault('E:/vault','E:/vault'));
});
