import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Lab} from './lab.mjs';

async function fixture(t,generate) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-lab-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.copyFile(new URL('./agents.json',import.meta.url),path.join(root,'agents.json'));
  return new Lab(root,generate).init();
}
test('私有资料不跨 Agent，且默认不进入教学和共享讨论',async t=>{
  const inputs=[];
  const lab=await fixture(t,async input=>{inputs.push(input);return '公开教学结果';});
  await fs.writeFile(lab.dir('researcher','knowledge')+'/secret.md','PRIVATE_SENTINEL');
  assert.match(await lab.context('researcher'),/PRIVATE_SENTINEL/);
  assert.doesNotMatch(await lab.context('practitioner'),/PRIVATE_SENTINEL/);
  await lab.teach('researcher','practitioner','实验设计');
  await lab.discuss('如何检验假设');
  assert.equal(inputs.length,9);
  for(const input of inputs) assert.doesNotMatch(JSON.stringify(input),/PRIVATE_SENTINEL/);
  assert.throws(()=>lab.agent('../researcher'));
});
test('教学需提供验证证据才能入库，且禁止重复入库',async t=>{
  const lab=await fixture(t,async()=> '教学内容');
  const lesson=await lab.teach('researcher','practitioner','实验');
  assert.deepEqual(await fs.readdir(lab.dir('practitioner','memory')),[]);
  await assert.rejects(lab.approve(lesson.id,''));
  await lab.approve(lesson.id,'人工验证：独立练习 3/3 通过');
  assert.match(await lab.context('practitioner'),/人工验证/);
  assert.doesNotMatch(await lab.context('researcher'),/人工验证/);
  await assert.rejects(lab.approve(lesson.id,'再次验证'));
});
test('失败任务保留已完成的步骤和错误状态',async t=>{
  let count=0;
  const lab=await fixture(t,async()=>{if(++count===2)throw Error('测试失败');return '第一步完成';});
  await assert.rejects(lab.discuss('测试课题'),/测试失败/);
  const folder=path.join(lab.root,'data','runs');
  const run=JSON.parse(await fs.readFile(path.join(folder,(await fs.readdir(folder))[0]),'utf8'));
  assert.equal(run.status,'failed');assert.equal(run.events.length,1);
});
