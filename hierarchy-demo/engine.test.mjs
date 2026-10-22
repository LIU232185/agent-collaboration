import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate,proposePolicy,validatePolicy,baselinePolicy} from './engine.mjs';
test('跨顶层反馈真正产生新消息，子 agent 修订后再验收',()=>{
  const r=simulate();assert.equal(r.audit.passed,true);assert.equal(r.retries,1);assert.equal(r.candidate.version,2);
  const feedback=r.events.findIndex(e=>e.level==='top'&&e.from==='risk'&&e.to==='marketing');
  const revision=r.events.findIndex(e=>e.to==='revise');assert.ok(feedback<revision);
  assert.equal(r.events.find(e=>e.fault).output.guaranteed,true);assert.equal(r.candidate.guaranteed,false);
});
test('关闭防护会交付错误，外部验收不偷偷修复',()=>{const r=simulate({protection:false});assert.equal(r.status,'delivered');assert.equal(r.audit.passed,false);assert.equal(r.candidate.guaranteed,true);});
test('零预算与无授权均阻断，不算修复成功',()=>{for(const opts of [{budget:0},{scenario:'denied'}]){const r=simulate(opts);assert.equal(r.status,'blocked');assert.equal(r.audit.passed,false);assert.equal(r.retries,0);}});
test('策略先回归再跨任务生效；旧策略和历史消息保持原样',()=>{
  const before=simulate(),patch=proposePolicy(before);assert.equal(validatePolicy(patch).passed,true);
  const after=simulate({policy:patch});assert.equal(after.retries,0);assert.equal(after.audit.passed,true);assert.equal(before.retries,1);assert.equal(baselinePolicy.precheck,false);
  assert.equal(simulate({scenario:'denied',policy:patch}).candidate,null);
});
test('干净输入无返工；所有场景配置组合满足授权与预算约束',()=>{
  assert.equal(simulate({fault:false}).retries,0);
  for(const scenario of ['price','trust','denied'])for(const fault of [true,false])for(const protection of [true,false])for(const budget of [0,1]){
    const r=simulate({scenario,fault,protection,budget});assert.ok(r.retries<=budget);
    if(protection&&r.status==='delivered')assert.equal(r.audit.passed,true);
  }
});
