import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.SEARCH_PLAYWRIGHT_PATH).href);
const server = await (await import('vite')).createServer({ server: { host: '127.0.0.1', port: 17803, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.SEARCH_BROWSER_PATH });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const base = 'http://127.0.0.1:17803/src/features/files/fixtures/page.html';
  await page.goto(base);

  // 没有「默认收纳盒」了：拖入必须先有一个打开的盒子，否则明确拒绝
  await page.evaluate(() => filesReview.fire('tauri://drag-drop', { paths: ['E:/Downloads/orphan.txt'], position: { x: 400, y: 300 } }));
  await page.waitForTimeout(200);
  assert.equal(
    await page.evaluate(async () => (await import('/src/stores/files.ts')).useFiles.getState().items.length),
    1,
    '没有打开的盒子时不该收集任何东西',
  );

  // 打开夹具里的盒子，后续拖入都落在它里面（先记下 id：打开后墙就不在了）
  await page.locator('[data-files-boxes]').waitFor();
  const boxId = await page.locator('[data-files-boxes] [data-box-card]').first().getAttribute('data-cat-id');
  await page.locator('[data-files-boxes] [data-box-card]').first().click();
  await page.locator('[data-box-panel]').waitFor();

  await page.getByPlaceholder('搜索名称或路径…').fill('does-not-match');
  await page.evaluate(() => filesReview.fire('tauri://drag-enter', { paths: ['E:/Downloads/example.txt'], position: { x: 400, y: 300 } }));
  await page.getByRole('status').filter({ hasText: '松开加入当前收纳盒' }).waitFor();
  await page.evaluate(() => filesReview.fire('tauri://drag-leave', null));
  await page.getByRole('status').filter({ hasText: '松开加入当前收纳盒' }).waitFor({ state: 'hidden' });

  await page.evaluate(() => filesReview.fire('tauri://drag-drop', {
    paths: ['E:/Downloads/example.txt', 'E:/Downloads/项目', 'e:\\downloads\\ALREADY.txt', 'E:/Downloads/missing.txt'],
    position: { x: 400, y: 300 },
  }));
  await page.getByText('example.txt', { exact: true }).waitFor();
  await page.getByText('项目', { exact: true }).waitFor();

  const imported = await page.evaluate(async () => (await import('/src/stores/files.ts')).useFiles.getState());
  assert.equal(imported.items.length, 3, '两条新的进库（重复与缺失各排一条）');
  assert.ok(
    imported.items.filter(item => item.id !== 'existing').every(item => item.categoryId === boxId),
    '拖入的条目要落在当前打开的盒子里',
  );
  assert.equal(imported.items.find(item => item.id === 'existing').categoryId, 'work');
  assert.deepEqual(imported.items.find(item => item.id === 'existing').tags, ['保留']);
  assert.equal(await page.getByPlaceholder('搜索名称或路径…').inputValue(), '', '拖入后清空搜索');

  // 重复拖入同一批：不变
  await page.evaluate(() => filesReview.fire('tauri://drag-drop', { paths: ['e:\\DOWNLOADS\\example.txt', 'E:/Downloads/项目/'], position: { x: 400, y: 300 } }));
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(async () => (await import('/src/stores/files.ts')).useFiles.getState().items.length), 3);

  // 取消的拖动不提交排序
  const order = await page.evaluate(async () => (await import('/src/stores/files.ts')).useFiles.getState().items.map(item => item.id));
  const first = page.locator('[data-box-panel] [data-card]').filter({ hasText: 'example.txt' });
  const last = page.locator('[data-box-panel] [data-card]').filter({ hasText: '项目' });
  const a = await first.boundingBox(), b = await last.boundingBox();
  await page.mouse.move(a.x + 15, a.y + 40);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 8, b.y + 40, { steps: 6 });
  await first.dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up();
  assert.deepEqual(
    await page.evaluate(async () => (await import('/src/stores/files.ts')).useFiles.getState().items.map(item => item.id)),
    order,
    'cancelled drag must not commit a reorder',
  );

  // 拖到另一个盒子上悬停 → 就地展开预览 → 松手移入
  const chip = page.locator('[data-drop-box]').first();
  const chipId = await chip.getAttribute('data-drop-box');
  const moving = page.locator('[data-box-panel] [data-card]').filter({ hasText: '项目' });
  const mb = await moving.boundingBox();
  const cb = await chip.boundingBox();
  await page.mouse.move(mb.x + 15, mb.y + 40);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2, { steps: 8 });
  await page.locator('[data-drop-preview]').waitFor({ timeout: 4000 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const afterMove = await page.evaluate(async () =>
    (await import('/src/stores/files.ts')).useFiles.getState().items.map(i => ({ id: i.id, categoryId: i.categoryId })));
  assert.ok(afterMove.some(i => i.categoryId === chipId), '悬停展开后松手要把条目移进目标盒');
  assert.equal(await page.locator('[data-drop-preview]').count(), 0, '松手后预览要收起');

  // 浮层是覆盖层，工具栏点不到：盒子头部有自己的「添加到此盒」入口
  await page.locator('[data-box-panel] header').getByRole('button', { name: '添加到此盒' }).click();
  await page.getByRole('dialog').waitFor();
  await page.evaluate(() => filesReview.fire('tauri://drag-drop', { paths: ['E:/Downloads/dialog-ignored.txt'], position: { x: 400, y: 300 } }));
  assert.equal(
    await page.evaluate(() => filesReview.calls.some(c => c.cmd === 'probe_paths' && c.args.paths.includes('E:/Downloads/dialog-ignored.txt'))),
    false,
  );
  // 预选了「当前打开的盒子」：对应 chip 应是按下态（确认按钮此刻因字段为空而禁用，不拿它断言）
  await page.getByRole('button', { name: '确认', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('dialog').locator('[data-box-picker] button[aria-pressed="true"]').count(),
    1,
    '开着盒子时默认预选它',
  );
  await page.getByRole('button', { name: '取消', exact: true }).click();

  await page.setViewportSize({ width: 760, height: 680 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow at narrow width');
  await page.screenshot({ path: 'Temp/files-collection-dark.png' });
  await page.evaluate(async () => { const { useSettings } = await import('/src/stores/settings.ts'); useSettings.getState().setTheme('light'); });
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'Temp/files-collection-light.png' });

  assert.deepEqual(errors, []);
  console.log('PASS Files: drop needs an open box, mixed drops land in it, dedupe, cancelled reorder, modal guard, narrow width, light/dark');
} finally { await browser.close(); await server.close(); }
