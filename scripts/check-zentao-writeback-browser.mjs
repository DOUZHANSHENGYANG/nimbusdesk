import assert from "node:assert/strict";
import { loadPlaywright, resolveBrowser } from "./browser-harness.mjs";
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
// The fixtures pull their modules through Vite's dev server, which resolves the
// whole dependency graph on first load; that regularly exceeds the 30s default.
page.setDefaultTimeout(120000);
const errors=[];page.on("pageerror",error=>errors.push(error.message));
const button=name=>page.getByRole("button",{name,exact:true});
try {
  await page.goto(`${process.env.ZENTAO_FIXTURE_ORIGIN ?? "http://127.0.0.1:17800"}/src/features/projects/fixtures/zentao-writeback.html`);
  // React mounts asynchronously, so wait for the row before interacting.
  await page.locator('[data-work-item="local-task"] button[aria-pressed]').waitFor({ state: "visible" });
  await page.locator('[data-work-item="local-task"] button[aria-pressed]').click();
  await button("待发送修改 · 1").click();
  await page.getByRole("dialog",{name:"核对禅道修改"}).waitFor();
  await page.evaluate(()=>window.zenWriteReview.stores.useZentao.getState().updateConnection('fixture',{writeFields:['title']}));
  for (const theme of ['dark','light']) {
    await page.setViewportSize({width:560,height:760});
    await page.evaluate(theme=>document.documentElement.classList.toggle('dark',theme==='dark'),theme);
    assert.equal(await page.getByRole('dialog').evaluate(element=>element.scrollWidth<=element.clientWidth+1),true,`${theme} comparison must fit a narrow window`);
  }
  await page.setViewportSize({width:1360,height:1000});
  await page.evaluate(()=>document.documentElement.classList.add('dark'));
  assert.equal(await button("确认发送到禅道").isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.zenWriteReview.calls.some(call=>call.cmd==='zentao_write_task')),false);
  await page.getByRole("checkbox",{name:"我已核对本次字段修改"}).check();
  await button("确认发送到禅道").click();
  await page.waitForFunction(()=>window.zenWriteReview.stores.useProjects.getState().remoteChanges.length===0);
  const writes=await page.evaluate(()=>window.zenWriteReview.calls.filter(call=>call.cmd==='zentao_write_task'));
  assert.equal(writes.length,1);assert.deepEqual(writes[0].args.changes,{title:'本地新标题'});
  await page.getByRole("dialog").getByRole("button",{name:"关闭",exact:true}).click();
  // An ordinary edit creates a durable intent; changed remote text must be compared.
  await page.evaluate(()=>{window.zenWriteReview.stores.useProjects.getState().updateItem('local-task',{title:'本地再次修改'});window.zenWriteReview.setRemote({title:'云端并发标题'});});
  await button("待发送修改 · 1").click();await button("更新云端值").click();
  await page.getByRole("group").getByText("云端并发标题",{exact:true}).waitFor();
  assert.equal(await button("确认发送到禅道").isDisabled(),true);
  await page.getByRole("radio",{name:"标题 · 采用云端"}).check();await button("应用字段选择").click();
  await page.waitForFunction(()=>window.zenWriteReview.stores.useProjects.getState().items.find(item=>item.id==='local-task').title==='云端并发标题');
  assert.equal(await page.evaluate(()=>window.zenWriteReview.calls.filter(call=>call.cmd==='zentao_write_task').length),1,"Choosing remote never sends a write");
  await page.getByRole("dialog").getByRole("button",{name:"关闭",exact:true}).click();
  await page.evaluate(()=>window.zenWriteReview.stores.useProjects.getState().updateItem('local-task',{title:'待人工调整'}));
  await button("待发送修改 · 1").click();
  await page.getByRole("radio",{name:"标题 · 手动修改"}).check();
  await page.getByRole("textbox",{name:"标题 · 手动修改"}).fill("人工确认的标题");
  await button("应用字段选择").click();
  await page.waitForFunction(()=>window.zenWriteReview.stores.useProjects.getState().items.find(item=>item.id==='local-task').title==='人工确认的标题');
  await page.getByRole("checkbox",{name:"我已核对本次字段修改"}).check();
  await page.evaluate(()=>window.zenWriteReview.stores.useProjects.getState().updateItem('local-task',{title:'另一窗口更新的标题'}));
  await page.waitForFunction(()=>document.querySelector('input[type=checkbox]')?.checked===false);
  assert.equal(await button("确认发送到禅道").isDisabled(),true,"A changed proposal invalidates the prior send confirmation");
  assert.equal(await page.evaluate(()=>window.zenWriteReview.calls.filter(call=>call.cmd==='zentao_write_task').length),1);
  await page.getByRole("dialog").getByRole("button",{name:"关闭",exact:true}).click();
  await page.evaluate(()=>{window.zenWriteReview.stores.useProjects.getState().updateItem('local-task',{title:'需要核实的修改'});window.zenWriteReview.writeError='ZENTAO_WRITE_UNCERTAIN';});
  await button("待发送修改 · 1").click();await page.getByRole("checkbox",{name:"我已核对本次字段修改"}).check();await button("确认发送到禅道").click();
  await page.getByText("结果待核实",{exact:true}).first().waitFor();
  assert.equal(await button("确认发送到禅道").isDisabled(),true);
  await page.evaluate(()=>window.zenWriteReview.flush());
  assert.equal(await page.evaluate(()=>window.zenWriteReview.fixtures.projects.state.remoteChanges[0].status),'uncertain');
  await page.evaluate(()=>{window.zenWriteReview.writeError=null;});
  await button("更新云端值").click();
  await page.getByText("发送失败",{exact:true}).first().waitFor();
  await page.getByRole("checkbox",{name:"我已核对本次字段修改"}).check();
  await button("确认发送到禅道").click();
  await page.waitForFunction(()=>window.zenWriteReview.stores.useProjects.getState().remoteChanges.length===0);
  await page.getByRole("dialog").getByRole("button",{name:"关闭",exact:true}).click();
  await button("禅道连接").click();
  assert.equal(await page.getByRole("checkbox",{name:"允许回写标题"}).isChecked(),true);
  assert.equal(await page.getByRole("checkbox",{name:"允许回写备注"}).isChecked(),false);
  assert.equal(await page.getByRole("checkbox",{name:"允许回写截止日期"}).isChecked(),false);
  assert.deepEqual(errors,[]);console.log("PASS opt-in ordinary fields, explicit send review, minimal patch, three-way conflict choice and uncertain retry lock");
} finally {await browser.close();}
