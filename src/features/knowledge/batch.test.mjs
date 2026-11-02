import test from 'node:test';
import assert from 'node:assert/strict';
import { batchKind, inferType, normalizeStatus, planBatch } from './batch.ts';

test('只有语义确定的组给批量动作', () => {
  assert.equal(batchKind('bad_status'), 'status');
  assert.equal(batchKind('no_type'), 'type');
  assert.equal(batchKind('no_owner'), 'owner');
  for (const id of ['duplicates', 'bad_dv', 'unclosed', 'draft_old', 'bom_md']) {
    assert.equal(batchKind(id), null, id);
  }
});

test('状态只落到 draft / published，认不出来当草稿', () => {
  assert.equal(normalizeStatus('进行中'), 'draft');
  assert.equal(normalizeStatus('已完成'), 'published');
  assert.equal(normalizeStatus('已发布'), 'published');
  assert.equal(normalizeStatus('WIP'), 'draft');
  assert.equal(normalizeStatus('乱写的'), 'draft');
  assert.equal(normalizeStatus(''), 'draft');
});

test('类型按区域推断，推不出来用最保守的技术知识', () => {
  assert.equal(inferType('02-IT/09-UIUX/a.md'), '技术知识');
  assert.equal(inferType('01-工作/04-项目管理/b.md'), '业务知识');
  assert.equal(inferType('03-生活/01-学习/c.md'), '学习笔记');
  assert.equal(inferType('04-资源/收藏/d.md'), '资源收藏');
  assert.equal(inferType('02-IT/06-项目研究/e.md'), '项目研究');
  assert.equal(inferType('99-系统/索引/f.md'), '技术知识');
});

test('计划保留旧值，供预览显示', () => {
  assert.deepEqual(planBatch('status', [{ path: 'a.md', detail: '进行中' }]), [
    { path: 'a.md', field: 'status', from: '进行中', to: 'draft', toLabel: '草稿' },
  ]);
  assert.deepEqual(planBatch('owner', [{ path: 'b.md' }]), [
    { path: 'b.md', field: 'tags', from: '（没标）', to: 'human', toLabel: '标记为我写的' },
  ]);
});
