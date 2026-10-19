import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.SEARCH_PLAYWRIGHT_PATH).href);
const server=await(await import('vite')).createServer({server:{host:'127.0.0.1',port:17813,strictPort:true}});await server.listen();
const browser=await chromium.launch({headless:true,executablePath:process.env.SEARCH_BROWSER_PATH});
try {
 const page=await browser.newPage();page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:17813/src/features/files/fixtures/icons.html');
 await page.locator('svg').waitFor();
 assert.equal(await page.evaluate(()=>iconReview.calls.length),0,'disabled native icons must not issue IPC');
 await page.evaluate(()=>iconReview.render({path:'good',native:true}));await page.locator('img').waitFor();
 await page.waitForFunction(()=>document.querySelector('img')?.naturalWidth>0);
 await page.evaluate(()=>iconReview.render({path:'pending'}));
 await page.waitForFunction(()=>iconReview.pending.resolve);
 assert.equal(await page.evaluate(()=>iconReview.snapshots.at(-1).src),null,'changing paths must never flash the preceding file icon');
 await page.evaluate(()=>iconReview.pending.resolve(iconReview.png));await page.locator('img').waitFor();
 await page.evaluate(()=>iconReview.render({path:'bad'}));
 await page.waitForFunction(()=>iconReview.imageErrors.includes(iconReview.results.bad));await page.locator('svg').waitFor();
 assert.equal(await page.locator('img').count(),0,'failed image decoding must retain the file fallback');
 await page.evaluate(()=>iconReview.render({path:'retry',mount:1}));await page.locator('svg').waitFor();
 await page.waitForFunction(()=>iconReview.calls.some(c=>c.path==='retry'));
 await page.evaluate(()=>{iconReview.results.retry=iconReview.png;const now=Date.now;Date.now=()=>now()+5000;iconReview.render({mount:2});});
 await page.locator('img').waitFor();
 assert.equal(await page.evaluate(()=>iconReview.calls.filter(c=>c.path==='retry').length),2,'transient failures may retry after a bounded cooldown');
 await page.evaluate(()=>iconReview.render({path:'other',native:false}));await page.locator('svg').waitFor();
 assert.equal(await page.evaluate(()=>iconReview.calls.filter(c=>c.path==='other').length),0);
 assert.deepEqual(errors,[]);console.log('PASS native icon opt-out, immediate path fallback, image error fallback and transient retry');
}finally{await browser.close();await server.close();}
