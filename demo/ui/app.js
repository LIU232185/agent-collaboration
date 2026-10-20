const $=id=>document.getElementById(id);
const original="export function addTask(tasks, text) {\n  tasks.push(text);\n  return tasks;\n}\n";
const names=['拒绝空字符串','拒绝纯空白','去除首尾空白','正常添加任务'];
let run=null,playing=false,pending=false,tab='current',timer=null;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statusNames={planned:'任务已规划',ready_for_test:'代码已提交',needs_revision:'需要修复',passed:'测试通过',completed:'验收通过',failed:'预算用尽',error:'执行异常'};
async function api(route,body){
  const response=await fetch('/api/'+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw Error(data.error||'请求失败');return data;
}
function stop(){playing=false;clearTimeout(timer);timer=null;render();}
function showError(error){$('error').textContent=error.message;$('error').hidden=false;stop();}
function describe(e){
  if(e.from==='规划员')return `验收拆成 4 项；修复预算为 ${e.max_rounds} 轮。接下来先检查原始代码。`;
  if(e.from==='编程员')return e.explanation;
  if(e.from==='测试员')return `${e.round===0?'原始版本':'第 '+e.round+' 轮'}：${e.results.filter(c=>c.passed).length}/4 通过。`+(e.failed.length?'失败项：'+e.results.filter(c=>!c.passed).map(c=>c.name).join('、')+'。':'全部验收条件满足。');
  return e.reason||'';
}
function render(){
  const done=run&&run.status!=='running';
  $('start').disabled=pending||playing;
  $('start').textContent=playing?'演示进行中…':done?'▶ 重新演示':run?'▶ 继续演示':'▶ 开始演示';
  $('next').disabled=pending||playing||done;
  $('pause').hidden=!playing;
  $('reset').disabled=pending;
  $('rounds').disabled=pending||playing||!!(run&&run.status==='running');
  $('download').disabled=!run;
  $('status').textContent=!run?'等待开始':run.status==='completed'?'验收通过':run.status==='failed'?'预算耗尽':run.status==='error'?'执行异常':playing?'协作进行中':'已暂停 · 可单步';
  $('round').innerHTML=`${run?run.round:'—'} <small>/ ${run?run.maxRounds:$('rounds').value}</small>`;
  const feedback=run?.feedback;
  $('passed').innerHTML=`${feedback?feedback.results.filter(c=>c.passed).length:'—'} <small>/ 4</small>`;
  $('messages').innerHTML=`${run?.events.length||0} <small>条记录</small>`;
  $('live-label').textContent=playing?'● 播放中':done?'任务已结束':run?'单步 / 已暂停':'等待任务';
  const active=!run?null:done?null:run.stage==='code'?'coder':'tester';
  for(const role of ['planner','coder','tester']){
    const card=$('agent-'+role);card.classList.toggle('active',role===active);card.classList.toggle('done',!!run&&role!==active);
    card.querySelector('.agent-state').textContent=!run?'待命':role===active?'下一步执行':done?'已结束':role==='planner'?'已规划':role==='coder'&&run.round===0?'等待任务':'已交接';
  }
  $('flow-caption').textContent=!run?'点击开始，观察任务如何流转':done?(run.status==='completed'?'协作完成，四项验收全部通过':'达到停止条件，保留失败记录'):run.stage==='code'?'接下来：编程员依据失败证据修复':'接下来：测试员运行真实检查';
  const events=run?.events||[];
  if(events.length){
    $('timeline').innerHTML=events.map(e=>`<article class="event"><div class="event-title"><span>${esc(e.from)} → ${esc(e.to)}</span><time>${esc(new Date(e.at).toLocaleTimeString('zh-CN',{hour12:false}))}</time></div><p><b>${esc(statusNames[e.status]||e.status)}</b> · ${esc(describe(e))}</p><details><summary>查看结构化交接</summary><pre>${esc(JSON.stringify(e,null,2))}</pre></details></article>`).join('');
  }else $('timeline').innerHTML='<div class="empty"><span>↔</span><h3>协作即将开始</h3><p>每个角色做了什么、交给谁，<br>都会记录在这里。</p></div>';
  const source=tab==='original'?original:run?.source||original;
  $('code').innerHTML=source.trimEnd().split('\n').map((line,i)=>`<span class="code-line"><span class="line-no">${i+1}</span>${esc(line)}</span>`).join('');
  $('version').textContent=tab==='original'||!run?.round?'原始版本':`第 ${run.round} 轮修复`;
  $('code-note').textContent=tab==='original'||!run?.round?'原始代码直接写入任务，没有处理空白输入。':run.round===1?'第一轮只判断空字符串；还需要真实测试检查是否遗漏。':'第二轮先去掉首尾空白，再拒绝空内容。';
  $('original-tab').classList.toggle('selected',tab==='original');$('original-tab').setAttribute('aria-pressed',String(tab==='original'));
  $('current-tab').classList.toggle('selected',tab==='current');$('current-tab').setAttribute('aria-pressed',String(tab==='current'));
  const stale=feedback&&feedback.round!==run.round;
  $('test-label').textContent=!feedback?'尚未执行':stale?`第 ${run.round} 轮代码待测 · 下方为上轮结果`:`${feedback.round===0?'原始版本':'第 '+feedback.round+' 轮'} · 真实执行`;
  $('tests').innerHTML=names.map((name,i)=>{
    const c=feedback?.results[i];return `<div class="test-row ${c?(c.passed?'pass':'fail'):''}"><span class="test-icon">${c?(c.passed?'✓':'×'):'·'}</span><span>${name}</span><span class="test-status">${c?(c.passed?'通过':'失败'):'等待执行'}</span></div>${c&&!c.passed?`<div class="test-detail">实际 ${esc(JSON.stringify(c.actual))} / 预期 ${esc(JSON.stringify(c.expected))}</div>`:''}`;
  }).join('');
  $('result').hidden=!done;
  $('result').classList.toggle('failed',!!done&&run.status!=='completed');
  if(done)$('result').textContent=run.status==='completed'?'✓ 协作完成：经过两轮修复，四项验收全部通过。':run.status==='failed'?'↳ 达到修复预算，仍有失败项。系统如实停止，没有宣称修复成功。':'执行出现异常，请查看交接记录中的错误。';
}
async function create(){
  const data=await api('start',{maxRounds:Number($('rounds').value)});run=data.run;tab='current';
}
async function advance(){
  if(pending)return;
  pending=true;$('error').hidden=true;render();
  try{
    if(!run)await create();else run=(await api('step',{id:run.id})).run;
    if(run.status!=='running')playing=false;
  }catch(error){showError(error);}finally{pending=false;render();}
}
async function tick(){
  if(!playing)return;
  await advance();
  if(playing)timer=setTimeout(tick,1300);
}
$('start').onclick=async()=>{
  if(pending)return;
  $('error').hidden=true;
  if(!run||run.status!=='running'){
    pending=true;render();
    try{await create();}catch(error){showError(error);return;}finally{pending=false;render();}
  }
  playing=true;render();timer=setTimeout(tick,1100);
};
$('next').onclick=advance;
$('pause').onclick=stop;
$('reset').onclick=()=>{stop();run=null;tab='current';$('error').hidden=true;render();};
$('rounds').onchange=render;
$('original-tab').onclick=()=>{tab='original';render();};
$('current-tab').onclick=()=>{tab='current';render();};
$('download').onclick=()=>{
  if(!run)return;
  const {directory,...record}=run;
  const url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='协作交接记录-'+run.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
render();
api('state').then(data=>{if(!pending&&!run&&data.run){run=data.run;render();}}).catch(showError);
