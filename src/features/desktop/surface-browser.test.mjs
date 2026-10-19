import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

const { chromium } = await import(pathToFileURL(process.env.SEARCH_PLAYWRIGHT_PATH).href);
const server = process.env.SEARCH_REVIEW_ORIGIN ? null : await (await import('vite')).createServer({
  server: { host: '127.0.0.1', port: 17809, strictPort: true },
});
await server?.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.SEARCH_BROWSER_PATH });

// A 1x1 Chromium PNG has one scanline and no preceding pixels, so every PNG
// filter leaves its first pixel unchanged. Inspect alpha without an image lib.
async function alphaAt(page, x, y) {
  const png = await page.screenshot({ omitBackground: true, clip: { x, y, width: 1, height: 1 } });
  assert.equal(png[24], 8, 'Chromium should emit an 8-bit PNG');
  assert.equal(png[25], 6, 'a transparent surface must have an RGBA canvas');
  const data = [];
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') data.push(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  return inflateSync(Buffer.concat(data))[4];
}

async function assertClear(page, note) {
  const backgrounds = await page.evaluate(() => [document.documentElement, document.body, document.getElementById('root')]
    .map(node => getComputedStyle(node).backgroundColor));
  assert.deepEqual(backgrounds, Array(3).fill('rgba(0, 0, 0, 0)'), `${note}: all document surfaces remain transparent`);
  assert.equal(await alphaAt(page, 0, 0), 0, `${note}: rounded outer corner exposes the desktop`);
  assert.equal(await alphaAt(page, 410, 200), 0, `${note}: unused strip beside preview exposes the desktop`);
}

try {
  const page = await browser.newPage({ viewport: { width: 412, height: 380 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = `${process.env.SEARCH_REVIEW_ORIGIN || 'http://127.0.0.1:17809'}/src/features/desktop/fixtures/edge.html`;
  for (const [query, label] of [['?docked', '展开10月18日'], ['?fence&docked', '展开Owned fence']]) {
    await page.goto(base + query);
    const tab = page.getByRole('button', { name: label, exact: true });
    await tab.waitFor();
    for (const theme of ['dark', 'light']) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      await assertClear(page, `${query}/${theme}/folded`);
      await tab.click();
      await page.waitForFunction(() => window.edgeReview.size.width > 112);
      await assertClear(page, `${query}/${theme}/expanded`);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => window.edgeReview.size.width === 112);
    }
  }
  await page.goto(base + '?hub');
  const hub = page.getByRole('button', { name: '桌面队列，0个窗口', exact: true });
  await hub.waitFor();
  await assertClear(page, 'queue');
  const surfaceAlpha = () => hub.evaluate(node => {
    const context = document.createElement('canvas').getContext('2d');
    context.fillStyle = getComputedStyle(node).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3];
  });
  await page.mouse.move(350, 300);
  assert.equal(await surfaceAlpha(), 255, 'queue resting surface stays opaque');
  await hub.hover();
  assert.equal(await surfaceAlpha(), 255, 'queue hover must not replace opaque material with a translucent color');
  await hub.focus();
  assert.equal(await surfaceAlpha(), 255, 'queue keyboard focus preserves opaque material');
  await page.mouse.down();
  assert.equal(await surfaceAlpha(), 255, 'queue pressed state preserves opaque material');
  await page.mouse.up();
  assert.deepEqual(errors, []);
  console.log('PASS paper/fence/queue transparent corners and both themes; opaque queue hover, focus and pressed states');
} finally {
  await browser.close();
  await server?.close();
}
