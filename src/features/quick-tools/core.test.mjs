import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptSelection } from './core.ts';
const selection=(revision,text='selected')=>({text,source:'uia',error:null,revision});
test('snapshot/event race and duplicates preserve the latest edit',()=>{
 assert.equal(acceptSelection(null,selection(1)),true);
 assert.equal(acceptSelection(selection(3),selection(2)),false);
 assert.equal(acceptSelection(selection(3),selection(3)),false);
 assert.equal(acceptSelection(selection(3),{...selection(4,''),source:'manual',error:'Unsupported'}),true);
});
test('reject invalid selection wire data and oversized input',()=>{
 for(const revision of [-1,Infinity,0.5])assert.equal(acceptSelection(null,selection(revision)),false);
 assert.equal(acceptSelection(null,selection(1,'a'.repeat(32769))),false);
 assert.equal(acceptSelection(null,{...selection(1),source:'clipboard'}),false);
});
