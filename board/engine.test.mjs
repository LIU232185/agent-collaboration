import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun,execute,route,parseModelRoute} from './engine.mjs';

test('自动路由为显式规则，不宣称训练后的控制器',()=>{
  assert.equal(route('比较两种培训方案').mode,'debate');
  assert.equal(route('调研协作机制').mode,'parallel');
  assert.equal(route('设计培训方案').mode,'chain');
  assert.equal(route('问题','parallel').controller,'rule-based');
  assert.throws(()=>route('问题','unknown'));
});

for(const mode of ['chain','parallel','debate'])test(`${mode}：交接来自已交付节点，最终输出如实标注演示`,async()=>{
  const run=createRun('设计培训方案',mode,'demo');
  const snapshots=[];
  await execute(run,{interval:0,onChange:async r=>snapshots.push(structuredClone(r))});
  assert.equal(run.status,'done');assert.equal(run.nodes.filter(n=>n.status==='done').length,4);
  assert.match(run.result,/尚未生成真实问题答案/);
  for(const event of run.events.filter(e=>e.type==='handoff')){
    const complete=run.events.find(e=>e.type==='complete'&&e.node===event.from);
    assert.ok(complete.id<event.id);assert.equal(event.content,complete.content);
  }
  if(mode!=='chain')assert.ok(snapshots.some(r=>r.nodes.filter(n=>n.status==='running').length===2));
  assert.equal(run.events.at(-1).type,'finished');
});

test('失败分支结束后不再启动审查或汇总',async()=>{
  const run=createRun('比较方案','parallel','live','fake');
  await execute(run,{generate:async id=>{if(id==='researcher')throw Error('测试失败');await new Promise(r=>setTimeout(r,10));return '方案';}});
  assert.equal(run.status,'failed');assert.equal(run.nodes[2].status,'skipped');
  const count=run.events.length;await new Promise(r=>setTimeout(r,20));assert.equal(run.events.length,count);
  assert.equal(run.result,'');
});

test('取消会中止演示等待且不启动后续节点',async()=>{
  const controller=new AbortController();const run=createRun('问题','chain','demo');
  await execute(run,{signal:controller.signal,onChange:async r=>{if(r.events.some(e=>e.type==='start'))controller.abort();}});
  assert.equal(run.status,'cancelled');assert.equal(run.nodes[1].status,'skipped');assert.equal(run.result,'');
});

test('真实适配器获得问题、职责和上游交接，共调用四次',async()=>{
  const calls=[];const run=createRun('用户的实际问题','chain','live','test-only');
  await execute(run,{generate:async(id,input)=>{calls.push({id,input});return `output:${id}`;}});
  assert.equal(run.status,'done');assert.equal(calls.length,4);
  assert.match(calls[1].input,/output:researcher/);assert.match(calls[3].input,/用户的实际问题/);
  assert.equal(run.result,'output:summary');
});

test('DeepSeek 先选择协作方式，再按所选拓扑执行，共五次调用',async()=>{
  const calls=[];const snapshots=[];const run=createRun('评估方案','model','live','deepseek-flash');
  assert.equal(run.plan.mode,'pending');assert.deepEqual(run.plan.edges,[]);
  await execute(run,{onChange:async r=>snapshots.push(structuredClone(r)),generate:async(id,input)=>{calls.push(id);return id==='router'?JSON.stringify({mode:'parallel',reason:'可从不同角度独立探索'}):'output:'+id;}});
  assert.equal(run.status,'done');assert.equal(calls.length,5);assert.equal(calls[0],'router');
  assert.equal(run.plan.mode,'parallel');assert.equal(run.plan.controller,'deepseek');assert.equal(run.plan.selectedByModel,'deepseek-flash');
  assert.ok(snapshots.some(r=>r.nodes.filter(n=>n.status==='running').length===2));
  assert.ok(run.events.find(e=>e.type==='route').id<run.events.find(e=>e.type==='start').id);
});

test('未知方式、无效 JSON 或空理由停止执行，不偷偷回落到规则',async()=>{
  for(const output of ['not json','{"mode":"execute_shell","reason":"请求执行"}','{"mode":"chain","reason":""}']){
    const run=createRun('问题','model','live','deepseek-flash');let calls=0;
    await execute(run,{generate:async()=>{calls++;return output;}});
    assert.equal(run.status,'failed');assert.equal(calls,1);assert.ok(run.nodes.every(n=>n.status==='skipped'));assert.equal(run.result,'');
  }
  assert.throws(()=>createRun('问题','model','demo'));
  assert.deepEqual(parseModelRoute('```json\n{"mode":"chain","reason":"步骤依赖"}\n```'),{mode:'chain',reason:'步骤依赖'});
});

test('选择协作方式期间取消，不再启动角色调用',async()=>{
  const controller=new AbortController(),run=createRun('问题','model','live','deepseek-flash');let calls=0;
  await execute(run,{signal:controller.signal,generate:async()=>{calls++;controller.abort();return '{"mode":"chain","reason":"顺序处理"}';}});
  assert.equal(run.status,'cancelled');assert.equal(calls,1);assert.ok(run.nodes.every(n=>n.status==='skipped'));
});
