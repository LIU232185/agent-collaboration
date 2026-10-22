import {teams,fixtures,baselinePolicy,simulate,proposePolicy,validatePolicy} from './engine.mjs';
const $=s=>document.querySelector(s),pretty=x=>JSON.stringify(x,null,2),esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let policy={...baselinePolicy},run,cursor=0,selected=0,timer=null,filter='all',completed=null,proposal=null,validation=null;
try{const saved=JSON.parse(localStorage.getItem('hierarchy-lab-v1')||'null');if(saved?.policy?.version===2&&saved.policy.precheck===true)policy=saved.policy;if(saved?.completed?.events?.length)completed=saved.completed;}catch{$('#storage-status').textContent='本地记录读取失败，使用初始策略。';}
const names={scheduler:'协作调度器',evaluator:'外部验收器',...Object.fromEntries(teams.flatMap(t=>[[t.id,t.name],...t.children.map(c=>[c[0],c[1]])]))};
const labels={control:'调度控制',internal:'内部协作',top:'顶层交接',evaluation:'外部验收'};
function save(){try{localStorage.setItem('hierarchy-lab-v1',pretty({policy,completed}));$('#storage-status').textContent='策略与最近完成记录已保存在本浏览器。';}catch{$('#storage-status').textContent='浏览器存储不可用，本次仅保留在页面内。';}}
function stop(){clearInterval(timer);timer=null;$('#play').textContent='自动播放';}
function showTab(name){document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));for(const n of ['run','evolution','guide'])$('#'+n+'-view').hidden=n!==name;renderEvolution();}
function customer(){const c=fixtures[$('#scenario').value];$('#customer').innerHTML=`<b>${esc(c.customer)}</b><p>${esc(c.reason)}</p><div>意向 ${c.intent} / 100 · 预算 ¥${c.budget}</div><p>模拟授权：${c.consent?'有':'无'}</p>`;}
function start(){stop();proposal=null;validation=null;run=simulate({scenario:$('#scenario').value,fault:$('#fault').checked,protection:$('#protection').checked,budget:Number($('#budget').value),policy});cursor=1;selected=0;$('#comparison').replaceChildren();render();}
function advance(){if(cursor>=run.events.length){stop();return;}cursor++;selected=cursor-1;if(cursor===run.events.length){completed=run;save();stop();}render();}
function render(){
  const shown=run.events.slice(0,cursor),event=run.events[selected],done=cursor===run.events.length;
  $('#step-label').textContent=`已展示 ${cursor} / ${run.events.length} 步 · ${done?'运行结束':'逐步执行中'}`;
  $('#policy-label').textContent=`当前策略 v${policy.version} · 本次运行 v${run.policyVersion}`;
  $('#status').textContent=done?(run.status==='blocked'?'已阻断':run.audit.passed?'验收通过':'不合格交付'):'执行中';
  $('#next').disabled=done;$('#play').disabled=done;$('#end').disabled=done;
  $('#teams').innerHTML=teams.map(t=>`<article class="team ${[event.from,event.to].includes(t.id)?'focused':''}"><button class="team-head" data-node="${t.id}"><span class="team-code">${t.id.toUpperCase()}</span><h3>${t.name}</h3><p>${t.subtitle}</p></button><div class="children">${t.children.map(([id,name,task])=>`<button data-node="${id}" class="child ${event.from===id||event.to===id?'focused':''}"><span>${shown.some(e=>e.to===id||e.from===id)?'●':'○'}</span><b>${name}</b><small>${task}</small></button>`).join('')}</div><div class="team-footer">顶层统一对外 · 子层分工执行</div></article>`).join('');
  $('#event-title').textContent=`${selected+1}. ${event.title}`;$('#event-level').textContent=labels[event.level];$('#event-level').className=event.level==='top'?'top-tag':'internal-tag';
  $('#event-path').textContent=`${names[event.from]} → ${names[event.to]}`;$('#input').textContent=pretty(event.input);$('#output').textContent=pretty(event.output);
  $('#timeline').innerHTML=shown.filter(e=>filter==='all'||e.level===filter).map(e=>`<button class="timeline-row ${e.id===selected+1?'selected':''}" data-event="${e.id-1}"><span class="step-no">${String(e.id).padStart(2,'0')}</span><span class="${e.level==='top'?'top-tag':'internal-tag'}">${labels[e.level]}</span><span>${esc(e.title)}</span><span>↗</span></button>`).join('')||'<p>当前进度还没有这一层级的事件。</p>';
  $('#result').innerHTML=done?`<div class="eyebrow">最终状态 · ${run.status==='blocked'?'阻断不计为成功交付':'方案只在本地生成'}</div><h2>${run.status==='blocked'?'已阻止流程继续':run.audit.passed?'候选方案通过本例验收':'不合格方案进入交付'}</h2><p>${run.status==='blocked'?'请查看阻断事件中的具体原因。':esc(run.candidate.copy)}</p><div class="metrics"><span>恢复次数 <b>${run.retries}</b></span><span>消息版本 <b>${run.candidate?'v'+run.candidate.version:'无候选'}</b></span><span>验收 <b>${run.status==='blocked'?'未交付':run.audit.passed?'通过':'失败'}</b></span></div><p class="small">${esc(run.audit.issues.join('；')||run.audit.note)}</p>`:'<h2>最终交付尚未发生</h2><p>继续下一步，观察风控是否放行、退回或阻断。</p>';
  renderEvolution();
}
function renderEvolution(){
  const eligible=completed?.options?.protection&&completed.events.some(e=>e.fault);
  $('#evidence').textContent=completed?`最近完成：${fixtures[completed.options.scenario]?.name||'本地案例'}；策略 v${completed.policyVersion}；返工 ${completed.retries} 次；${completed.audit.passed?'验收通过':completed.status==='blocked'?'阻断':'验收失败'}。`:'尚无完成任务。';
  $('#proposal').disabled=!eligible;$('#validate').disabled=!proposal;$('#activate').disabled=!validation?.passed;
  $('#patch').textContent=proposal?pretty(proposal):'尚未生成候选策略。';
  $('#validation').innerHTML=validation?`<p>${validation.passed?'✓ 固定用例通过':'未通过，不可启用'}</p><table><thead><tr><th>案例</th><th>返工 v1 → v2</th><th>预期检查</th></tr></thead><tbody>${validation.checks.map(c=>`<tr><td>${c.scenario}</td><td>${c.beforeRetries} → ${c.afterRetries}</td><td>${c.passed?'通过':'失败'}${c.status==='blocked'?'（阻断）':''}</td></tr>`).join('')}</tbody></table><p class="small">${validation.note}</p>`:'';
}
$('#tabs').addEventListener('click',e=>{const b=e.target.closest('[data-tab]');if(b){stop();showTab(b.dataset.tab);}});
$('.filters').addEventListener('click',e=>{const b=e.target.closest('[data-filter]');if(b){filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active',x===b));render();}});
$('#teams').addEventListener('click',e=>{const b=e.target.closest('[data-node]');if(!b)return;const id=b.dataset.node,t=teams.find(t=>t.id===id||t.children.some(c=>c[0]===id));const child=t.children.find(c=>c[0]===id);$('#node-info').textContent=child?`${t.name} 内部的 ${child[1]}：${child[2]}。由团队内部流程调用。`:`${t.name}：${t.subtitle}。封装 ${t.children.length} 个子角色，通过顶层消息与其他团队交接。`;});
$('#timeline').addEventListener('click',e=>{const b=e.target.closest('[data-event]');if(b){stop();selected=Number(b.dataset.event);render();}});
$('#scenario').addEventListener('change',customer);$('#start').onclick=start;$('#next').onclick=advance;
$('#play').onclick=()=>{if(timer){stop();return;}$('#play').textContent='暂停';timer=setInterval(advance,1100);};
$('#end').onclick=()=>{stop();cursor=run.events.length;selected=cursor-1;completed=run;save();render();};
$('#compare').onclick=()=>{
  const opts=run.options,a=simulate({...opts,protection:false}),b=simulate({...opts,protection:true});
  $('#comparison').innerHTML=`<h3>同一输入、同一策略</h3><table><thead><tr><th>检查</th><th>结果</th><th>返工</th></tr></thead><tbody>${[[a,'关闭'],[b,'启用']].map(([r,n])=>`<tr><td>${n}</td><td>${r.status==='blocked'?'阻断':r.audit.passed?'合格交付':'不合格交付'}</td><td>${r.retries}</td></tr>`).join('')}</tbody></table><p class="small">比较使用本次运行配置。策略 v2 可能已在生成前避免错误，因此两组都可能通过。</p>`;
};
$('#proposal').onclick=()=>{proposal=proposePolicy(completed);validation=null;renderEvolution();};
$('#validate').onclick=()=>{validation=validatePolicy(proposal);renderEvolution();};
$('#activate').onclick=()=>{if(!validation?.passed)return;policy={...proposal};save();$('#scenario').value='price';$('#fault').checked=true;$('#protection').checked=true;$('#budget').value='1';customer();start();showTab('run');$('#evo-status').textContent='已启用策略 v2。返回协作现场查看新的执行顺序。';};
$('#rollback').onclick=()=>{policy={...baselinePolicy};proposal=null;validation=null;save();$('#evo-status').textContent='已回滚到 v1；下一次运行生效，已有运行保持原策略。';render();};
$('#export').onclick=()=>{const payload={run,revealedSteps:cursor,policy,candidatePolicy:proposal,validation,note:'导出包含完整计划运行记录；页面可能尚未播放完。'};const url=URL.createObjectURL(new Blob([pretty(payload)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='两层agent实验记录.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
customer();start();
