// Uses the same local fixture and installed browser as the search browser suites.
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL(process.env.SEARCH_PLAYWRIGHT_PATH).href);
const browser=await chromium.launch({headless:true,executablePath:process.env.SEARCH_BROWSER_PATH});
try {
  const page=await browser.newPage({viewport:{width:760,height:560}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${process.env.SEARCH_REVIEW_ORIGIN||'http://127.0.0.1:17802'}/Temp/search-review.html`);
  const input=page.getByRole('combobox');await input.waitFor();
  await page.evaluate(()=>{
    window.searchReview.nativeIconData='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>';
    const hit=(id,kind,path,score)=>({id,kind,path,score,title:id,subtitle:'',snippet:'',route:'/knowledge'});
    window.searchReview.resultOverride=[hit('说明.txt','file','C:/tools/说明.txt',1000),hit('工具.exe','file','C:/tools/工具.exe',10),hit('文件夹','folder','C:/tools/文件夹',9),hit('笔记','knowledge','C:/notes/笔记.md',8)];
  });
  await input.fill('native');
  const rows=page.getByRole('option');await rows.first().waitFor();
  assert.match(await rows.first().innerText(),/工具.exe/);
  await rows.filter({hasText:'工具.exe'}).locator('img').waitFor();
  await rows.filter({hasText:'文件夹'}).locator('img').waitFor();
  assert.equal(await rows.filter({hasText:'笔记'}).locator('img').count(),0);
  assert.equal(await page.evaluate(()=>window.searchReview.calls.filter(call=>call.cmd==='native_icon'&&call.args.path==='C:/notes/笔记.md').length),0);
  await page.evaluate(()=>{window.searchReview.nativeIconData=null;window.searchReview.resultOverride=[{id:'fallback',kind:'file',path:'C:/missing/fallback.pdf',score:1,title:'fallback.pdf',subtitle:'',snippet:''}];});
  await input.fill('fallback');await rows.filter({hasText:'fallback.pdf'}).waitFor();
  await rows.filter({hasText:'fallback.pdf'}).locator('svg.quick-search-kind-icon').waitFor();
  await page.goto(`${process.env.SEARCH_REVIEW_ORIGIN||'http://127.0.0.1:17802'}/Temp/search-review.html?settings`);
  await page.getByText('文档正文索引',{exact:true}).waitFor();
  await page.evaluate(()=>{const store=window.searchReview.store;store.setState({status:{...store.getState().status,files:{running:false,paused:false,total:4,processed:4,indexed:4,failed:0,current:null,error:null,updatedAt:1,nameRunning:false,nameTotal:300,nameIndexed:200}}});});
  await page.getByText('部分完成',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS: executable priority, native file/folder icons, no native icon requests for business notes, generic fallback, distinct document/pinyin progress and partial status, no page errors.');
} finally {await browser.close();}
