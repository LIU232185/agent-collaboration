import test from 'node:test';
import assert from 'node:assert/strict';
import {createResilienceRun,executeResilience,checkCandidate} from './resilience.mjs';

const config={quantity:12,unitPrice:35,fault:'wrong_total',protection:'both',maxRetries:1};
for(const fault of ['wrong_total','missing_basis','none'])for(const protection of ['none','challenger','inspector','both'])test(`${fault} / ${protection}：依据实际最终交付验算`,async()=>{
  const run=createResilienceRun({...config,fault,protection});
  await executeResilience(run,{interval:0,compare:false});
  assert.equal(run.status,'done');
  assert.equal(run.resilience.audit.passed,fault==='none'||protection!=='none');
  assert.equal(run.resilience.recovered,fault!=='none'&&protection!=='none');
  assert.equal(run.resilience.versions.length,fault==='none'?1:protection==='none'?2:3);
  if(protection!=='none'&&fault!=='none'){
    assert.ok(run.events.find(e=>e.type==='quarantine').id<run.events.find(e=>e.type==='recovered').id);
    const finalHandoff=run.events.find(e=>e.type==='handoff'&&e.to==='summary');
    assert.deepEqual(JSON.parse(finalHandoff.content),{quantity:12,unitPrice:35,total:420});
  }
  if(fault==='wrong_total'&&protection==='none')assert.equal(run.resilience.audit.actualTotal,455);
});

for(const protection of ['challenger','inspector','both'])test(`${protection}：无重算预算必须阻断，不得宣称修复`,async()=>{
  const run=createResilienceRun({...config,protection,maxRetries:0});
  await executeResilience(run,{interval:0,compare:false});
  assert.equal(run.status,'blocked');assert.equal(run.result,'');assert.equal(run.resilience.recovered,false);
  assert.equal(run.nodes.find(n=>n.id==='summary').status,'skipped');
  assert.ok(!run.events.some(e=>e.type==='handoff'&&e.to==='summary'));
});

test('四组对照拥有独立运行证据，题目、注入及预算一致',async()=>{
  const run=createResilienceRun(config);await executeResilience(run,{interval:0});
  assert.equal(run.resilience.comparisonTrials.length,4);
  assert.equal(new Set(run.resilience.comparisonTrials.map(r=>r.id)).size,4);
  for(const trial of run.resilience.comparisonTrials){assert.equal(trial.question,run.question);assert.equal(trial.resilience.config.fault,config.fault);assert.equal(trial.resilience.config.maxRetries,1);assert.equal(trial.resilience.comparisonTrials.length,0);}
  assert.deepEqual(run.resilience.comparison.map(r=>r.passed),[false,true,true,true]);
});

test('检查器仅凭题目和候选消息验证，不依赖故障标记',()=>{
  assert.equal(checkCandidate({quantity:9,unitPrice:17},{quantity:9,unitPrice:17,total:153}).passed,true);
  assert.equal(checkCandidate({quantity:9,unitPrice:17},{quantity:9,unitPrice:17,total:154}).passed,false);
  assert.equal(checkCandidate({quantity:9,unitPrice:17},{total:153}).passed,false);
  assert.throws(()=>createResilienceRun({...config,quantity:1.5}));
  assert.throws(()=>createResilienceRun({...config,protection:'unknown'}));
});

test('取消中间运行保留已有证据且停止后续节点',async()=>{
  const run=createResilienceRun(config),controller=new AbortController();
  await executeResilience(run,{signal:controller.signal,onChange:async r=>{if(r.events.some(e=>e.type==='fault'))controller.abort();},interval:0});
  assert.equal(run.status,'cancelled');assert.equal(run.resilience.comparison.length,0);assert.equal(run.result,'');
  assert.ok(!run.events.some(e=>e.type==='handoff'&&e.to==='summary'));
});
