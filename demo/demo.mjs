// Offline role simulation. Only the bundled fixture is executed, never user code.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.dirname(fileURLToPath(import.meta.url));
const requirement = '修复待办任务添加功能：拒绝空字符串和纯空白，去除首尾空白，正常任务保持可用。';
const checks = [
  {id:'empty', name:'拒绝空字符串', input:'', expected:[]},
  {id:'spaces', name:'拒绝纯空白', input:' \t ', expected:[]},
  {id:'trim', name:'去除首尾空白', input:'  学习多智能体  ', expected:['学习多智能体']},
  {id:'normal', name:'正常添加任务', input:'写报告', expected:['写报告']},
];
const sources = [
  `export function addTask(tasks, text) {\n  tasks.push(text);\n  return tasks;\n}\n`,
  `export function addTask(tasks, text) {\n  if (text === '') return tasks;\n  tasks.push(text);\n  return tasks;\n}\n`,
  `export function addTask(tasks, text) {\n  const clean = text.trim();\n  if (!clean) return tasks;\n  tasks.push(clean);\n  return tasks;\n}\n`,
];

// Each role has a separate function and receives an explicit handoff.
function planner(request) {
  return {task_id:'todo-001', from:'规划员', to:'编程员', status:'planned',
    requirement:request, acceptance:checks.map(c=>({id:c.id,name:c.name})),
    file:'todo.mjs', max_rounds:2};
}
function coder(plan, feedback, round) {
  assert.equal(plan.task_id,'todo-001');
  if (round === 2) assert.deepEqual(feedback.failed,['spaces','trim']);
  return {task_id:plan.task_id, from:'编程员', to:'测试员', status:'ready_for_test',
    round, source:sources[round],
    explanation:round === 1 ? '第一轮只拦截空字符串，故意保留一个常见遗漏。' : '依据测试反馈，先去除首尾空白，再判断是否为空。'};
}
async function tester(directory, handoff) {
  const runner = `import {addTask} from './todo.mjs';
const checks = ${JSON.stringify(checks)};
const results = checks.map(c => {
  try {
    const actual = addTask([], c.input);
    return {...c, actual, passed:JSON.stringify(actual)===JSON.stringify(c.expected)};
  } catch(error) {return {...c, passed:false, error:error.message};}
});
console.log(JSON.stringify(results));
process.exitCode = results.every(c=>c.passed) ? 0 : 1;
`;
  await fs.writeFile(path.join(directory,'verify.mjs'),runner);
  const result = spawnSync(process.execPath,['verify.mjs'],{
    cwd:directory, encoding:'utf8', timeout:5000, windowsHide:true,
  });
  if (result.error) throw result.error;
  if (![0,1].includes(result.status)) throw Error(result.stderr || '测试进程异常结束');
  let results;
  try { results=JSON.parse(result.stdout); } catch {throw Error('测试结果无法解析：'+result.stderr);}
  return {task_id:handoff.task_id, from:'测试员', to:'调度程序',
    status:results.every(c=>c.passed)?'passed':'needs_revision',
    round:handoff.round, exit_code:result.status, results,
    failed:results.filter(c=>!c.passed).map(c=>c.id)};
}
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function report(run) {
  const rounds=run.events.filter(e=>e.from==='测试员');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>多智能体协作 · 入门 Demo</title>
<style>body{margin:0;background:#f3f5f9;color:#17233a;font:16px/1.8 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1080px;margin:auto;padding:40px 24px}h1{font-size:34px;line-height:1.3}h2{font-size:23px;margin-top:0}.tag{color:#16624f;background:#def3e9;padding:5px 12px;border-radius:20px}.cards,.codes{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.codes{grid-template-columns:1fr 1fr}section,article{background:white;border:1px solid #e0e5ee;border-radius:16px;padding:22px;margin:20px 0}article{margin:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#101b2e;color:#d7e5fc;border-radius:10px;padding:18px;font-size:14px}table{width:100%;border-collapse:collapse}td,th{text-align:left;border-bottom:1px solid #e5e9ef;padding:10px}.pass{color:#08734f}.fail{color:#b83c27}summary{cursor:pointer;font-weight:600}small{color:#52627b}@media(max-width:720px){.cards,.codes{grid-template-columns:1fr}h1{font-size:27px}td,th{padding:6px;font-size:14px}}</style>
<main><span class="tag">零密钥 · 零第三方依赖 · 本地运行</span><h1>让三个角色一起修好一段代码</h1><p>观察规划、交接、测试反馈与再次修复的完整闭环。</p>
<section><strong>这是离线教学模拟：</strong>三个角色的决策由预设规则生成，没有调用大模型；代码文件的写入和测试执行是真实的。本报告是运行后的静态记录，刷新不会重新运行。</section>
<div class="cards"><article><h2>① 规划员</h2>把需求转换成可验收任务，约定修改文件和最多两轮修复。</article><article><h2>② 编程员</h2>第一轮漏掉空白处理，第二轮根据失败证据修改。</article><article><h2>③ 测试员</h2>由独立测试进程检查四条需求，输出实际值和预期值。</article></div>
<section><h2>本次任务</h2><p>${esc(requirement)}</p><p><b>结果：${run.status==='completed'?'验收通过':'未通过验收'}</b> · 修复 ${run.rounds} 轮 · 模型调用 0 次</p><small>案例和验收范围固定，仅演示字符串输入下的待办添加功能；不代表通用自动修复能力。</small></section>
${rounds.map(r=>`<section><h2>${r.round===0?'修复前的基线检查':'第 '+r.round+' 轮修复后'}</h2><table><tr><th>验收项</th><th>实际输出</th><th>预期输出</th><th>结果</th></tr>${r.results.map(c=>`<tr><td>${esc(c.name)}</td><td>${esc(JSON.stringify(c.actual))}</td><td>${esc(JSON.stringify(c.expected))}</td><td class="${c.passed?'pass':'fail'}">${c.passed?'通过':'失败'}</td></tr>`).join('')}</table></section>`).join('')}
<section><h2>代码前后对比</h2><div class="codes"><div>修复前<pre>${esc(sources[0])}</pre></div><div>最终版本<pre>${esc(run.final_source)}</pre></div></div></section>
<section><h2>角色交接记录</h2><p>每个角色提交结构化消息；调度程序只根据测试状态与剩余轮数推进。</p>${run.events.map((e,i)=>`<details><summary>${i+1}. ${esc(e.from)} → ${esc(e.to)} · ${esc(e.status)}</summary><pre>${esc(JSON.stringify(e,null,2))}</pre></details>`).join('')}</section>
<section><h2>你刚刚看到的原理</h2><p><b>职责分工：</b>规划、修改、验证使用不同入口。<br><b>共享状态：</b>任务编号将各轮消息关联起来。<br><b>反馈闭环：</b>失败用例驱动下一轮修改。<br><b>停止条件：</b>全部通过即交付，达到轮数上限则报告失败。<br><b>事实验证：</b>通过与否取决于测试进程，不取决于角色的自我评价。</p><small>结果文件和过程记录均保存在本报告所在目录。详见 demo/README.md。</small></section></main></html>`;
}

async function main() {
  await fs.mkdir(path.join(root,'runs'),{recursive:true});
  const directory=await fs.mkdtemp(path.join(root,'runs','run-'));
  const run={mode:'offline-scripted-roles',requirement,status:'running',rounds:0,events:[]};
  const plan=planner(requirement);
  run.events.push(plan);
  await fs.writeFile(path.join(directory,'todo.mjs'),sources[0]);
  let feedback=await tester(directory,{task_id:plan.task_id,round:0});
  run.events.push(feedback);
  console.log('离线教学模拟：角色使用预设规则，测试真实执行。');
  console.log('需求：'+requirement);
  console.log('修复前：'+feedback.results.filter(c=>c.passed).length+'/4 通过');
  for(let round=1;round<=plan.max_rounds && feedback.status!=='passed';round++) {
    const handoff=coder(plan,feedback,round);
    run.events.push(handoff);
    await fs.writeFile(path.join(directory,'todo.mjs'),handoff.source);
    feedback=await tester(directory,handoff);
    run.events.push(feedback);
    run.rounds=round;
    console.log('第 '+round+' 轮：'+feedback.results.filter(c=>c.passed).length+'/4 通过'+(feedback.failed.length?'；失败：'+feedback.failed.join(', '):''));
  }
  run.status=feedback.status==='passed'?'completed':'failed';
  run.final_source=await fs.readFile(path.join(directory,'todo.mjs'),'utf8');
  run.events.push({task_id:plan.task_id,from:'调度程序',to:'用户',status:run.status,reason:run.status==='completed'?'全部验收条件通过':'达到最大修复轮数'});
  await fs.writeFile(path.join(directory,'trace.json'),JSON.stringify(run,null,2));
  await fs.writeFile(path.join(directory,'report.html'),report(run));
  await fs.writeFile(path.join(root,'latest-report.html'),report(run));
  // Verify the educational sequence itself, in addition to the executed fixture tests.
  assert.deepEqual(run.events.filter(e=>e.from==='测试员').map(e=>e.results.filter(c=>c.passed).length),[1,2,4]);
  assert.equal(run.status,'completed');
  console.log('结果：'+run.status+'\n报告：'+path.join(root,'latest-report.html')+'\n运行记录：'+directory);
}
export {planner, coder, tester, sources, requirement};
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
