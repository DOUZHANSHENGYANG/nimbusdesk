import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

const {chromium}=await import(pathToFileURL(process.env.SEARCH_PLAYWRIGHT_PATH).href);
const server=await(await import('vite')).createServer({server:{host:'127.0.0.1',port:17809,strictPort:true}});
await server.listen();
const browser=await chromium.launch({headless:true,executablePath:process.env.SEARCH_BROWSER_PATH});
try {
 const page=await browser.newPage({viewport:{width:420,height:420}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 const base='http://127.0.0.1:17809/src/features/desktop/fixtures/edge.html';
 const paper=()=>page.evaluate(async()=>{const {usePapers}=await import('/src/stores/papers.ts');return usePapers.getState().papers['2099-10-18'];});
 const drag=async(target,hold=false)=>{
  await page.evaluate(({target,hold})=>{edgeReview.dragTarget=target;edgeReview.holdDragWait=hold;},{target,hold});
  const title=page.locator('.daily-paper span[title^="2099-10-18 ·"]');await title.waitFor();
  const r=await title.boundingBox();await page.mouse.move(r.x+10,r.y+7);await page.mouse.down();await page.mouse.move(r.x+35,r.y+10,{steps:4});await page.mouse.up();
 };
 await page.goto(base);await drag({x:380,y:3},true);
 await page.waitForFunction(()=>typeof edgeReview.finishDrag==='function',{},{timeout:4000});
 assert.equal((await paper()).form,'paper','a posted native drag is not a finished drag');
 await page.evaluate(()=>edgeReview.finishDrag(true));
 await page.waitForFunction(async()=>{const {usePapers}=await import('/src/stores/papers.ts');return usePapers.getState().papers['2099-10-18'].form==='capsule';});
 let state=await paper();assert.equal(state.edge,'top');assert.equal(state.dockOffset,380);assert.equal(state.edgeMonitor,'Owned monitor@0,0');
 assert.deepEqual([state.x,state.y,state.w,state.h],[380,3,300,380],'normal geometry survives docking');
 console.log('PASS normal plan title drag waits for release, docks at the top and preserves its normal rectangle');

 for(const [target,edge,offset]of[[{x:4,y:240},'left',240],[{x:972,y:130},'right',130]]){
  await page.goto(base);await drag(target);
  await page.waitForFunction(async()=>{const {usePapers}=await import('/src/stores/papers.ts');return usePapers.getState().papers['2099-10-18'].form==='capsule';});
  state=await paper();assert.equal(state.edge,edge);assert.equal(state.dockOffset,offset);
 }
 await page.goto(base);await drag({x:350,y:220});await page.waitForTimeout(250);assert.equal((await paper()).form,'paper');
 await page.goto(base);await drag({x:380,y:3},true);await page.waitForFunction(()=>typeof edgeReview.finishDrag==='function');
 await page.evaluate(()=>edgeReview.finishDrag(false));await page.waitForTimeout(200);assert.equal((await paper()).form,'paper','canceled drags never dock');
 console.log('PASS side docking, ordinary free movement and canceled drag');

 await page.goto(base);await drag({x:380,y:3},true);await page.waitForFunction(()=>typeof edgeReview.finishDrag==='function');
 await page.evaluate(async()=>{const {usePapers}=await import('/src/stores/papers.ts');usePapers.getState().setForm('2099-10-18','capsule');edgeReview.finishDrag(true);});
 await page.waitForTimeout(200);state=await paper();assert.notEqual(state.edge,'top');assert.deepEqual([state.x,state.y,state.w,state.h],[220,170,300,380],'a completed old drag cannot overwrite a newer form');
 console.log('PASS a delayed native drag cannot overwrite a newer sticky form');

 await page.goto(base);await page.locator('.daily-paper').waitFor();
 await page.evaluate(()=>{edgeReview.position={x:380,y:3};void edgeReview.fire('tauri://move',edgeReview.position);});
 await page.waitForTimeout(200);assert.equal((await paper()).form,'paper','resize/programmatic move events do not enter sticky form');
 await page.evaluate(()=>{edgeReview.monitor.scaleFactor=1.5;edgeReview.monitor.workArea.position={x:-1920,y:90};edgeReview.monitor.workArea.size={width:1920,height:990};edgeReview.size={width:450,height:570};});
 await drag({x:-1425,y:96});
 await page.waitForFunction(async()=>{const {usePapers}=await import('/src/stores/papers.ts');return usePapers.getState().papers['2099-10-18'].form==='capsule';});
 state=await paper();assert.equal(state.edge,'top');assert.equal(state.dockOffset,330);assert.deepEqual([state.x,state.y,state.w,state.h],[-950,64,300,380]);
 assert.deepEqual(errors,[]);
 console.log('PASS programmatic moves do not dock; negative monitor origin and mixed-DPI offsets stay logical; no runtime errors');
} finally {await browser.close();await server.close();}
