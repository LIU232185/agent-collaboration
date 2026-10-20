// Integration check; start demo/server.mjs before running this file.
import assert from 'node:assert/strict';
const base='http://127.0.0.1:4321';
async function post(route,body,origin=base){
  return fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
}
assert.equal((await fetch(base)).status,200);
assert.equal((await fetch(base+'/app.js')).status,200);
assert.equal((await fetch(base+'/style.css')).status,200);
assert.equal((await post('start',{maxRounds:2},'https://example.com')).status,403);
assert.equal((await post('start',{maxRounds:9})).status,400);
for(const maxRounds of [1,2]){
  let response=await post('start',{maxRounds});assert.equal(response.status,200);
  let run=(await response.json()).run;
  assert.equal(run.events[0].from,'规划员');
  let count=0;
  while(run.status==='running'&&count++<8){
    response=await post('step',{id:run.id});assert.equal(response.status,200);
    run=(await response.json()).run;
  }
  assert.equal(run.status,maxRounds===1?'failed':'completed');
  assert.equal(run.round,maxRounds);
  assert.deepEqual(run.events.filter(e=>e.from==='测试员').map(e=>e.results.filter(c=>c.passed).length),maxRounds===1?[1,2]:[1,2,4]);
  assert.equal(run.events.at(-1).from,'调度程序');
  assert.equal((await post('step',{id:'stale-run'})).status,409);
  console.log(`${maxRounds} 轮预算：${run.status}，测试结果与停止条件正确`);
}
console.log('页面资源、来源校验、预算校验、过期任务拦截均通过。');
