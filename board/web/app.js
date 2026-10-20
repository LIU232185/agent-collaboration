const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const status={waiting:'等待',running:'执行中',done:'已交付',failed:'失败',cancelled:'已停止',skipped:'未执行',interrupted:'运行中断',blocked:'已阻断',quarantined:'消息隔离'};
const protectionNames={none:'无防护',challenger:'Challenger',inspector:'Inspector',both:'质疑 + 检查'};
const modes={chain:'链式协作',parallel:'并行探索',debate:'多视角讨论',pending:'DeepSeek 正在选择…'};
let run=null,selected='researcher',detail='output',lastRevision='',pending=false,active=null,viewEvent=null;
async function api(url,body){const res=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const data=await res.json();if(!res.ok)throw Error(data.error||'请求失败');return data;}
function error(e){$('error').hidden=false;$('error').textContent=e.message;}
function drawGraph(){
  const nodes=run?.nodes||[{id:'researcher',name:'研究员'},{id:'practitioner',name:'实践员'},{id:'reviewer',name:'审查员'},{id:'summary',name:'汇总员'}].map(n=>({...n,status:'waiting'}));
  const chain=!run||['chain','pending'].includes(run.plan.mode);
  const hasInspector=nodes.some(n=>n.id==='inspector');
  const positions=hasInspector?{researcher:[50,9],practitioner:[50,29],inspector:[50,49],reviewer:[50,69],summary:[50,89]}:chain?{researcher:[50,15],practitioner:[50,39],reviewer:[50,63],summary:[50,87]}:{researcher:[25,20],practitioner:[75,20],reviewer:[50,53],summary:[50,84]};
  const container=$('graph'),width=container.clientWidth,height=container.clientHeight;
  container.className='graph '+(hasInspector?'resilience':chain?'chain':'parallel');
  const edges=run?.plan.edges||[['researcher','practitioner'],['practitioner','reviewer'],['reviewer','summary']];
  let svg=`<svg viewBox="0 0 ${width} ${height}" aria-hidden="true"><defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0L6 3L0 6" fill="#8da996" stroke="none"/></marker></defs>`;
  for(const [a,b] of edges){const x1=positions[a][0]*width/100,y1=positions[a][1]*height/100+28,x2=positions[b][0]*width/100,y2=positions[b][1]*height/100-31;const delivered=run?.events.some(e=>e.type==='handoff'&&e.from===a&&e.to===b);svg+=`<path class="${delivered?'delivered':''}" d="M${x1},${y1} C${x1},${(y1+y2)/2} ${x2},${(y1+y2)/2} ${x2},${y2}" marker-end="url(#arrow)"/>`;}
  if(run?.events.some(e=>e.type==='challenge')){const checker=hasInspector?'inspector':'reviewer';const y1=positions[checker][1]*height/100,y2=positions.practitioner[1]*height/100;svg+=`<path class="repair-edge" d="M${width/2-67},${y1} C24,${y1} 24,${y2} ${width/2-67},${y2}" marker-end="url(#arrow)"/><text x="16" y="${(y1+y2)/2}" class="repair-label">退回</text>`;}
  container.innerHTML=svg+'</svg>'+nodes.map(n=>`<button type="button" data-node="${n.id}" class="node ${n.status} ${selected===n.id?'active':''}" aria-pressed="${selected===n.id}"><strong>${esc(n.name)}</strong><small>${status[n.status]}</small></button>`).join('');
  for(const button of container.querySelectorAll('[data-node]'))button.onclick=()=>{selected=button.dataset.node;viewEvent=null;drawGraph();drawDetail();};
}
function drawDetail(){
  const node=run?.nodes.find(n=>n.id===selected);
  $('detail-title').textContent=node?.name||'节点详情';$('detail-status').textContent=node?status[node.status]:'可点击节点';
  $('detail-task').textContent=node?.task||'选择智能体，查看职责、收到的材料和交付内容。';
  $('detail-content').textContent=viewEvent?.content||(node?.[detail]||(detail==='output'?'尚未交付。':'尚未收到材料。'));
  if(viewEvent)$('detail-task').textContent=viewEvent.message+' · 交接快照';
  for(const t of ['input','output']){$(t+'-tab').classList.toggle('selected',t===detail);$(t+'-tab').setAttribute('aria-pressed',String(t===detail));}
}
function draw(){
  $('start').disabled=pending||!!active;$('cancel').disabled=!run||run.status!=='running'||active!==run.id;$('export').disabled=!run;
  $('run-title').textContent=run?.question||'协作现场';$('run-status').textContent=run?status[run.status]:'等待任务';
  $('run-mode').textContent=run?`${modes[run.plan.mode]}${run.plan.controller==='deepseek'?' · DeepSeek 已选择':''}`:'尚未选择协作方式';$('run-backend').textContent=run?`${run.kind==='resilience'?'机制实验':run.backend==='demo'?'演示模板':'真实模型'} · ${run.model}`:'无模型调用';
  $('progress').textContent=`${run?.nodes.filter(n=>n.status==='done').length||0} / ${run?.nodes.length||4} 已交付`;
  $('route-reason').textContent=run?`${run.plan.reason}。${run.plan.modelRouting}`:'提交问题后，显示路由选择和节点状态。';
  $('event-count').textContent=`${run?.events.length||0} 条事件`;
  $('timeline').innerHTML=run?.events.length?run.events.map(e=>`<button class="event event-${esc(e.type)}" type="button" data-event="${e.id}"><time>${new Date(e.at).toLocaleTimeString('zh-CN',{hour12:false})}</time><span class="message">${esc(e.message)}${e.content?'　↗ 查看内容':''}</span></button>`).join(''):'<p class="empty">每次开始、交接和交付都会记录在这里。</p>';
  for(const button of $('timeline').querySelectorAll('[data-event]'))button.onclick=()=>{const e=run.events.find(e=>e.id===Number(button.dataset.event));if(e.node)selected=e.node;if(e.to)selected=e.to;viewEvent=e.content?e:null;drawGraph();drawDetail();};
  $('result-panel').hidden=!run||run.status==='running';$('result-label').textContent=run?.kind==='resilience'?'确定性算术 · 原题独立验算':run?.backend==='demo'?'规则模板 · 非真实问题答案':'模型生成 · 待独立核验';$('result').textContent=run?.result||run?.error||'';
  $('resilience-panel').hidden=!run?.resilience;
  if(run?.resilience){const r=run.resilience;$('resilience-summary').textContent=`${r.config.fault==='none'?'无故障对照':run.events.some(e=>e.type==='fault')?'故障已注入':'等待故障注入'} · ${r.detected?'异常已检出':'尚未检出异常'} · 重算 ${r.retries}/${r.config.maxRetries} 次 · ${r.recovered?'恢复验算通过':run.status==='blocked'?'未修复，已阻断':'未发生修复'}`;
    $('comparison-body').innerHTML=r.comparison.length?r.comparison.map(row=>`<tr><th>${protectionNames[row.protection]}</th><td>${row.detected?'已检出':'未检出'} / ${row.recovered?'已修复':'无修复'}</td><td>${row.contaminatedHandoffs}</td><td>${row.actualTotal===null?'未交付':row.actualTotal+' 元'}</td><td class="${row.passed?'audit-pass':'audit-fail'}">${row.status==='blocked'?'已阻断':row.passed?'通过':'未通过'}</td></tr>`).join(''):'<tr><td colspan="5">当前运行结束后自动计算四组对照。</td></tr>';
    $('versions').textContent=JSON.stringify(r.versions,null,2);
  }
  drawGraph();drawDetail();
}
async function refresh(){
  const state=await api('/api/state');active=state.active;
  $('connection').textContent='● 本地服务在线';
  const live=$('backend').querySelector('[value="live"]');live.disabled=!state.configured;live.textContent=state.configured?`真实模型 · ${state.model}`:state.provider==='deepseek'?'DeepSeek Flash · 待填写本地密钥':'真实模型 · 尚未配置';
  $('mode').querySelector('[value="model"]').disabled=!(state.configured&&state.provider==='deepseek');
  $('reload-config').disabled=!!active;
  $('history').innerHTML=state.runs.length?state.runs.map(r=>`<button type="button" data-run="${r.id}">${esc(r.question.slice(0,65))}<small>${esc(status[r.status])} · ${r.backend==='demo'?'本地演示':'真实模型'}</small></button>`).join(''):'<p class="note">还没有任务，试试上面的示例。</p>';
  for(const button of $('history').querySelectorAll('[data-run]'))button.onclick=async()=>{try{run=await api('/api/run?id='+button.dataset.run);lastRevision='';viewEvent=null;draw();}catch(e){error(e);}};
  if(!run&&(state.active||state.runs[0]))run=await api('/api/run?id='+(state.active||state.runs[0].id));
  if(run){const next=await api('/api/run?id='+run.id);const revision=next.id+':'+next.events.length+':'+next.status;if(revision!==lastRevision){run=next;lastRevision=revision;draw();}}
  $('start').disabled=pending||!!active;
}
$('example').onclick=()=>{$('question').value='为新员工设计一个两周入职培训方案，明确实施步骤、角色分工和验收标准。';$('question').focus();};
$('reload-config').onclick=async()=>{try{const config=await api('/api/reload-config',{});$('config-status').textContent=config.configured?`已读取 ${config.provider} / ${config.model}，未发起模型调用。`:`${config.provider}：请在项目 .env 填写 API 密钥后再点此按钮。`;$('error').hidden=true;await refresh();}catch(e){error(e);}};
$('backend').onchange=()=>{const live=$('backend').value==='live';if(!live&&$('mode').value==='model')$('mode').value='auto';const calls=$('mode').value==='model'?5:4;$('cost-row').hidden=!live;$('cost').checked=false;$('cost-label').textContent=`确认本次最多 ${calls} 次模型调用会产生费用`;$('mode-note').textContent=live?`最多 ${calls} 次调用，每次最多 3000 输出 token，不自动重试。${calls===5?'含 1 次 DeepSeek 协作方式选择。':''}停止后不启动新节点；已发出的请求仍可能计费。`:'演示输出为规则模板，不会真实回答任意问题。';};
$('mode').onchange=()=>{if($('mode').value==='model')$('backend').value='live';$('backend').onchange();};
function updateExperiment(){const enabled=$('resilience').checked;$('experiment-controls').hidden=!enabled;$('mode').disabled=enabled;$('backend').disabled=enabled;$('question').readOnly=enabled;$('example').disabled=enabled;if(enabled){$('backend').value='demo';$('backend').onchange();$('mode-note').textContent='本模式实际执行确定性算术、故障注入和验算，不调用模型。';$('question').value=`采购 ${$('quantity').value} 件商品，每件 ${$('unit-price').value} 元，总价是多少？`;}else $('backend').onchange();}
$('resilience').onchange=updateExperiment;for(const id of ['quantity','unit-price'])$(id).oninput=updateExperiment;
$('task-form').onsubmit=async e=>{e.preventDefault();if(pending)return;pending=true;$('error').hidden=true;$('start').disabled=true;try{const experiment=$('resilience').checked?{quantity:Number($('quantity').value),unitPrice:Number($('unit-price').value),fault:$('fault').value,protection:$('protection').value,maxRetries:Number($('retry-budget').value)}:undefined;run=await api('/api/start',{question:$('question').value,mode:$('mode').value,backend:$('backend').value,confirmCost:$('cost').checked,experiment});active=run.id;selected='researcher';viewEvent=null;lastRevision='';draw();}catch(e){error(e);}finally{pending=false;$('start').disabled=!!active;}};
$('cancel').onclick=async()=>{try{await api('/api/cancel',{id:run.id});$('cancel').disabled=true;}catch(e){error(e);}};
for(const tab of ['input','output'])$(tab+'-tab').onclick=()=>{detail=tab;viewEvent=null;drawDetail();};
$('export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(run,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`collaboration-${run.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
new ResizeObserver(drawGraph).observe($('graph'));
draw();
async function poll(){try{await refresh();}catch(e){$('connection').textContent='服务暂时不可达';}setTimeout(poll,700);}void poll();
