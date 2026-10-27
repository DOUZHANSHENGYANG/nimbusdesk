import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.SEARCH_PLAYWRIGHT_PATH).href);
const server=await(await import('vite')).createServer({server:{host:'127.0.0.1',port:17803,strictPort:true}});await server.listen();
const browser=await chromium.launch({headless:true,executablePath:process.env.SEARCH_BROWSER_PATH});
try{
 const page=await browser.newPage({viewport:{width:1000,height:760}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const base='http://127.0.0.1:17803/src/features/files/fixtures/page.html';await page.goto(base);
 // 「全部显示到桌面 / 全部不显示到桌面」这对按钮已经从文件页删掉了（现在只剩按分类的开关，
 // library 层由 desktop-actions.test.mjs 覆盖）。这个浏览器用例不再断言批量开关。
 await page.getByPlaceholder('搜索名称或路径…').fill('does-not-match');
 await page.evaluate(()=>filesReview.fire('tauri://drag-enter',{paths:['E:/Downloads/example.txt'],position:{x:400,y:300}}));
 await page.getByRole('status').filter({hasText:'松开添加到默认分类'}).waitFor();
 await page.evaluate(()=>filesReview.fire('tauri://drag-leave',null));await page.getByRole('status').filter({hasText:'松开添加到默认分类'}).waitFor({state:'hidden'});
 await page.evaluate(()=>filesReview.fire('tauri://drag-drop',{paths:['E:/Downloads/example.txt','E:/Downloads/项目','e:\\downloads\\ALREADY.txt','E:/Downloads/missing.txt'],position:{x:400,y:300}}));
 await page.getByText('example.txt',{exact:true}).waitFor();await page.getByText('项目',{exact:true}).waitFor();
 const imported=await page.evaluate(async()=>{const{useFiles}=await import('/src/stores/files.ts');return useFiles.getState();});
 assert.equal(imported.items.length,3);const defaults=imported.categories.find(c=>c.name==='默认分类');assert.ok(defaults);assert.ok(imported.items.filter(i=>i.id!=='existing').every(i=>i.categoryId===defaults.id));
 assert.equal(imported.items.find(i=>i.id==='existing').categoryId,'work');assert.deepEqual(imported.items.find(i=>i.id==='existing').tags,['保留']);
 assert.equal(await page.getByPlaceholder('搜索名称或路径…').inputValue(),'');
 await page.evaluate(()=>filesReview.fire('tauri://drag-drop',{paths:['e:\\DOWNLOADS\\example.txt','E:/Downloads/项目/'],position:{x:400,y:300}}));
 await page.waitForTimeout(300);assert.equal(await page.evaluate(async()=>{const{useFiles}=await import('/src/stores/files.ts');return useFiles.getState().items.length;}),3);
 const order=await page.evaluate(async()=>{const{useFiles}=await import('/src/stores/files.ts');return useFiles.getState().items.map(item=>item.id);});
 const first=page.locator('[data-card]').filter({hasText:'example.txt'}),last=page.locator('[data-card]').filter({hasText:'项目'});
 const a=await first.boundingBox(),b=await last.boundingBox();
 await page.mouse.move(a.x+15,a.y+40);await page.mouse.down();await page.mouse.move(b.x+b.width-8,b.y+40,{steps:6});
 await first.dispatchEvent('pointercancel',{pointerId:1});await page.mouse.up();
 assert.deepEqual(await page.evaluate(async()=>{const{useFiles}=await import('/src/stores/files.ts');return useFiles.getState().items.map(item=>item.id);}),order,'cancelled drag must not commit a reorder');
 await page.getByRole('button',{name:'添加条目',exact:true}).click();await page.getByRole('dialog').waitFor();
 await page.evaluate(()=>filesReview.fire('tauri://drag-drop',{paths:['E:/Downloads/dialog-ignored.txt'],position:{x:400,y:300}}));
 assert.equal(await page.evaluate(()=>filesReview.calls.some(c=>c.cmd==='probe_paths'&&c.args.paths.includes('E:/Downloads/dialog-ignored.txt'))),false);
 await page.getByRole('button',{name:'取消',exact:true}).click();
 await page.setViewportSize({width:760,height:680});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow at narrow width');
 await page.screenshot({path:'Temp/files-collection-dark.png'});
 await page.evaluate(async()=>{const{useSettings}=await import('/src/stores/settings.ts');useSettings.getState().setTheme('light');});
 await page.waitForTimeout(200);await page.screenshot({path:'Temp/files-collection-light.png'});
 assert.deepEqual(errors,[]);console.log('PASS Files: native mixed drops, default/duplicate/filter behavior, modal guard, cancelled reorder, narrow width, light/dark');
}finally{await browser.close();await server.close();}
