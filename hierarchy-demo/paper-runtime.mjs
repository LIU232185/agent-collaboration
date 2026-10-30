import {prompts} from './prompts.mjs';
import {randomUUID} from 'node:crypto';
export const teams=[
 {id:'customer',name:'摇摆户 Agent',scope:'客户需求、事实与行为障碍。若问题不是客户营销，不把校招生等内部人员当成摇摆户，只负责需求澄清、事实和待验证假设。',children:[{id:'profile',name:'需求与事实核查',task:'区分用户已给事实、一般机制、待验证假设与缺失信息'},{id:'hesitation',name:'行为与障碍分析',task:'从需求和参与障碍视角提供有条件的机制解释，不编造人群动机'}]},
 {id:'marketing',name:'营销 Agent',scope:'业务价值、方案设计与效果评估。非营销问题仅从业务参与和试点设计视角分析，不假扮组织人才专家。',children:[{id:'offer',name:'方案设计',task:'提出符合题意、可试点的业务方案，区分建议与已执行动作'},{id:'measurement',name:'效果评估',task:'设计可核验指标、对照方式与实施前提；数值只能标为建议或示例'}]},
 {id:'risk',name:'风控 Agent',scope:'风险、权限、证据及边界。评审分析与建议，不宣称拥有生产权限或实施业务操作；不杜撰本行制度或法律禁令。',children:[{id:'permission',name:'权限与边界',task:'检查授权、数据访问、生产与试点边界，未知制度标为待核实'},{id:'basis',name:'证据与承诺检查',task:'核对事实、假设和建议是否混淆，识别未经支撑的承诺或因果断言'}]}
];
export const modes={
 parallel:{name:'并行会诊',description:'三个顶层团队独立分析，最后综合；减少前序观点锚定。',deps:{customer:[],marketing:[],risk:[]}},
 chain:{name:'动态链式',description:'按问题选择三个团队的先后，后续团队读取前面全部已审查结论。',deps:{customer:[],marketing:['customer'],risk:['customer','marketing']}},
 customer_fanout:{name:'需求先行 · 双路并行',description:'摇摆户澄清需求后，营销与风控并行。',deps:{customer:[],marketing:['customer'],risk:['customer']}},
 risk_fanout:{name:'风控先行 · 双路并行',description:'风控先明确边界，摇摆户与营销再并行。',deps:{risk:[],customer:['risk'],marketing:['risk']}},
 debate:{name:'多轮交叉辩论',description:'三个团队独立初稿后，按轮互读上一轮已审查结论、回应质疑并更新；每轮独立审查。',deps:{customer:[],marketing:[],risk:[]}}
};
class OutputError extends Error{}
const parse=text=>{try{const p=JSON.parse(text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));if(!p||typeof p!=='object'||Array.isArray(p))throw Error();return p;}catch{throw new OutputError('模型 JSON 结构无效');}};
export function createPaperRun({task,model,collaboration='auto',router='llm',debateRounds=2,debateMode='auto',chainOrder='auto'}){
 if(typeof task!=='string'||!task.trim()||task.length>4000)throw Error('请输入 1–4000 字的问题');
 if(collaboration!=='auto'&&!modes[collaboration])throw Error('不支持的协作方式');if(!['llm','rules'].includes(router))throw Error('训练路由器尚未接入；当前支持 LLM 或规则基线');
 if(!Number.isInteger(debateRounds)||debateRounds<1||debateRounds>3)throw Error('辩论轮数须为 1–3 的整数');
 if(!['auto','fixed'].includes(debateMode))throw Error('辩论结束方式须为 auto 或 fixed');
 if(chainOrder!=='auto')validateChainOrder(chainOrder);
 return {chainOrder,debateMode,maxDebateRounds:debateMode==='auto'?3:debateRounds,debateRounds,debateHistory:[],id:randomUUID(),kind:'paper-live',version:'fixed-teams-v4',task:task.trim(),model,collaboration,router,status:'running',startedAt:new Date().toISOString(),calls:[],events:[],versions:[],accepted:{},warnings:[],limit:48};
}
export function ruleRoute(task){return /生产|敏感数据|隐私|授权|合规审批/.test(task)?'risk_fanout':/营销|摇摆户|客户/.test(task)?'customer_fanout':'parallel';}
export function validateChainOrder(order){
 if(!Array.isArray(order)||order.length!==3||new Set(order).size!==3||order.some(id=>!teams.some(t=>t.id===id)))throw new OutputError('链式顺序必须包含三个已注册团队且各一次');return [...order];
}
export function ruleChainOrder(task){return /生产|敏感|隐私|授权|客户数据/.test(task)?['risk','customer','marketing']:/已有.*方案|现有.*方案|评审.*方案|优化.*方案/.test(task)?['marketing','customer','risk']:['customer','marketing','risk'];}
export function validatePlan(p,model){
 if(!modes[p.mode]||typeof p.reason!=='string'||!p.reason.trim())throw new OutputError('协作方式或理由无效');
 // 身份和子 Agent 均由注册表控制，模型只能对现有团队分派工作。
 const chainOrder=p.mode==='chain'?validateChainOrder(p.chainOrder||['customer','marketing','risk']):undefined;
 const assignments=p.assignments||{};
 if(Object.keys(assignments).some(id=>!teams.some(t=>t.id===id)))throw new OutputError('禁止创建注册表以外的顶层角色');
 return {chainOrder,orderSource:p.orderSource,mode:p.mode,name:modes[p.mode].name,reason:p.reason,roles:teams.map(t=>({...structuredClone(t),model,task:typeof assignments[t.id]==='string'?assignments[t.id].slice(0,1000):t.scope,dependencies:chainOrder?chainOrder.slice(0,chainOrder.indexOf(t.id)):[...modes[p.mode].deps[t.id]]})),candidateModels:[model]};
}
const codes=new Set(['fabricated_fact','contradiction','unsupported_execution','unsafe_action','missing_core_answer']);
export function normalizeReview(review,payload){
 if(!Array.isArray(review.issues)||typeof review.reason!=='string')throw new OutputError('审查字段缺失');
 const strings=x=>typeof x==='string'?[x]:x&&typeof x==='object'?Object.values(x).flatMap(strings):[];
 const content=strings(payload).join('\n'),issues=review.issues.map(x=>{
  if(typeof x==='string')return {severity:'minor',code:'advisory',finding:x,quote:'',grounded:false};
  if(!x||typeof x.finding!=='string')throw new OutputError('审查问题结构无效');
  const grounded=typeof x.quote==='string'&&x.quote.trim().length>=4&&content.includes(x.quote.trim());
  const actionable=['critical','major'].includes(x.severity)&&codes.has(x.code)&&grounded;
  return {...x,severity:actionable?x.severity:'minor',grounded,actionable};
 });
 const blocking=issues.filter(x=>x.actionable);
 return {decision:blocking.length?'revise':issues.length?'warn':'pass',issues,reason:review.reason,blocking,reportedDecision:review.decision};
}
export async function executePaperRun(run,{invoke,emit=async()=>{},signal}){
 let inFlight=0;const waiters=[];
 const acquire=async()=>{if(inFlight>=2)await new Promise(resolve=>waiters.push(resolve));else inFlight++;};
 const release=()=>{if(waiters.length)waiters.shift()();else inFlight--;};
 const event=async(type,title,data={})=>{run.events.push({seq:run.events.length+1,time:new Date().toISOString(),type,title,...data});await emit();};
 const warn=async(message)=>{run.warnings.push(message);await event('warning',message);};
 async function once(id,name,instructions,input,team,maxOutputTokens=3000){
  signal?.throwIfAborted();if(run.calls.length>=run.limit)throw Error('达到调用预算，停止追加请求');
  const c={id,name,team,status:'queued',instructions,input,queuedAt:new Date().toISOString()};run.calls.push(c);await event('queued',name+' · 等待 API 名额',{callId:id});let start=Date.now(),acquired=false;
  try{await acquire();acquired=true;signal?.throwIfAborted();start=Date.now();c.startedAt=new Date().toISOString();c.queueMs=start-Date.parse(c.queuedAt);c.status='running';await event('call',name,{callId:id});const result=await invoke({instructions,input:JSON.stringify(input),jsonMode:true,maxOutputTokens,team,callId:id},signal);Object.assign(c,result,{output:result.text,status:'done'});return {value:parse(result.text),call:c};}catch(e){Object.assign(c,e.metadata||{});c.status=e instanceof OutputError?'invalid':'failed';c.error=e.message;throw e;}finally{if(acquired)release();c.latencyMs=Date.now()-start;await emit();}
 }
 async function ask(id,name,prompt,input,team,validate=x=>x,maxOutputTokens=3000){
  const instructions=prompt+prompts.common;
  try{const {value,call}=await once(id,name,instructions,input,team,maxOutputTokens);try{return validate(value);}catch(e){call.status='invalid';call.error=e.message;throw new OutputError(e.message);}}catch(e){
   if(!(e instanceof OutputError))throw e;
   const previous=run.calls.findLast(c=>c.id===id)?.output||'';
   await event('format_repair',name+' · 一次结构纠正请求',{callId:id,error:e.message});
   const {value}=await once(id+'-format',name+' · 结构纠正',prompts.formatRepair+instructions,{originalInput:input,previous:previous.slice(0,8000),formatError:e.message},team,maxOutputTokens);
   try{return validate(value);}catch(err){const c=run.calls.at(-1);c.status='invalid';c.error=err.message;throw new OutputError(err.message);}
  }
 }
 const worker=prompts.worker;
 const workerValid=x=>{if(typeof x.answer!=='string'||!x.answer.trim())throw new OutputError('执行结果缺少 answer');return x;};
 async function gate(id,name,payload,context,repair){
  for(let version=1;version<=3;version++){
   const item={messageId:id,version,payload,status:'pending'};run.versions.push(item);let review;
   try{review=await ask(id+'-inspect-'+version,name+' · Inspector '+version,
    prompts.inspector,
    {question:run.task,context,message:payload},id,x=>normalizeReview(x,payload));
   }catch(e){if(!(e instanceof OutputError))throw e;item.status='quarantined';item.reviewError=e.message;await warn(name+' 审查结构纠正后仍无效：隔离此消息，保留其他团队结果');return {answer:name+' 的消息未能完成审查，未向下游传递原始内容。',withheld:true,limitations:['审查服务输出结构异常，需人工复核']};}
   item.review=review;
   if(!review.blocking.length){item.status=review.issues.length?'accepted_with_warnings':'accepted';if(review.issues.length)await warn(name+'：保留 '+review.issues.length+' 条非阻断审查建议');await event(version>1?'recovered':'handoff',name+' · '+(review.issues.length?'带建议交接':'审查放行'),{messageId:id,version});return payload;}
   item.status='quarantined';await event('quarantine',name+' · 实质问题隔离',{messageId:id,version,review});
   if(version===3){await warn(name+' 两次修订后仍有实质问题：隔离原文，仅传递缺失说明');return {answer:name+' 的候选结论未通过实质性检查，原文已隔离。',withheld:true,limitations:review.blocking.map(x=>x.code+'：需人工核实后才能采用该部分')};}
   payload=await repair(payload,review.blocking);await event('revision',name+' · 修订 '+version+'，等待独立复审',{messageId:id});
  }
 }
 try{
  let decision;
  if(run.collaboration!=='auto'){decision={mode:run.collaboration,reason:'用户显式选择 '+modes[run.collaboration].name};run.selectedBy='manual';}
  else if(run.router==='rules'){decision={mode:ruleRoute(run.task),reason:'可审计规则基线：敏感/权限类优先风控，客户营销类需求先行，其余并行；没有训练或最优性保证。'};run.selectedBy='rules';}
  else{
   run.selectedBy='llm';await event('planning','在固定团队和方式候选中自动选择');
   try{decision=await ask('planner','MasRouter 思想 · 受约束规划',prompts.planner,{question:run.task,teams,modes,candidateModels:[run.model]},undefined,x=>{validatePlan(x,run.model);return x;});}
   catch(e){if(!(e instanceof OutputError))throw e;decision={mode:'parallel',reason:'模型规划经一次结构纠正仍无效，显式采用固定团队并行基线。'};run.selectedBy='explicit-fallback';await warn(decision.reason);}
  }
  if(decision.mode==='chain'){
   if(Array.isArray(run.chainOrder)){decision.chainOrder=validateChainOrder(run.chainOrder);decision.orderSource='manual';decision.reason+='；链式顺序由用户指定';}
   else if(run.router==='rules'){decision.chainOrder=ruleChainOrder(run.task);decision.orderSource='rules';decision.reason+='；按权限优先、已有方案优先或需求优先的规则选择顺序';}
   else if(decision.chainOrder){validateChainOrder(decision.chainOrder);decision.orderSource='llm';}
   else{
    try{const order=await ask('chain-router','动态链式 · 选择团队顺序',prompts.chainRouter,{question:run.task,teams},undefined,x=>{validateChainOrder(x.chainOrder);if(typeof x.reason!=='string'||!x.reason.trim())throw new OutputError('缺少选序理由');return x;});decision.chainOrder=order.chainOrder;decision.orderSource='llm';decision.reason+='；'+order.reason;}
    catch(e){if(!(e instanceof OutputError))throw e;decision.chainOrder=ruleChainOrder(run.task);decision.orderSource='explicit-fallback';await warn('链式选序经结构纠正仍无效，显式使用规则顺序');}
   }
  }
  run.plan=validatePlan(decision,run.model);run.plan.selectedBy=run.selectedBy;await event('plan','已确定固定团队协作图',{plan:run.plan});
  while(Object.keys(run.accepted).length<3){
   const ready=run.plan.roles.filter(r=>!Object.hasOwn(run.accepted,r.id)&&r.dependencies.every(id=>Object.hasOwn(run.accepted,id)));
   if(!ready.length)throw Error('依赖无法推进');
   const outcomes=await Promise.allSettled(ready.map(async r=>{
    const upstream=Object.fromEntries(r.dependencies.map(id=>[id,run.accepted[id]]));
    const children=await Promise.allSettled(r.children.map(c=>ask(c.id,c.name,worker,{question:run.task,identity:r.name,scope:r.scope,assignment:c.task,upstream},r.id,workerValid)));
    signal?.throwIfAborted();
    for(const [i,x] of children.entries())if(x.status==='rejected')await warn(r.name+' / '+r.children[i].name+' 调用失败，未重试；仅使用其余材料并披露缺失：'+x.reason.message);
    if(children.every(x=>x.status==='rejected'))throw Error(r.name+' 的子任务均不可用');
    const context={question:run.task,identity:r.name,scope:r.scope,assignment:r.task,upstream,children:children.map((x,i)=>x.status==='fulfilled'?x.value:{withheld:true,answer:r.children[i].name+' 调用失败，没有可用结论；不得补造。'})};
    const candidate=await ask(r.id,r.name+' · 汇总与质疑',worker,context,r.id,workerValid);
    run.accepted[r.id]=await gate(r.id,r.name,candidate,context,(previous,issues)=>ask(r.id+'-repair-'+run.versions.filter(v=>v.messageId===r.id).length,r.name+' · 反馈修订',worker,{...context,previous,requiredCorrections:issues},r.id,workerValid));await emit();
   }));signal?.throwIfAborted();
   for(const [i,x] of outcomes.entries())if(x.status==='rejected'){const r=ready[i];run.accepted[r.id]={withheld:true,answer:r.name+' 调用或审查失败，没有可交接的已审查结论。',limitations:[x.reason.message]};await warn(r.name+' 不可用，隔离该分支并保留其他团队：'+x.reason.message);}
   if(Object.keys(run.accepted).length===3&&Object.values(run.accepted).every(x=>x.withheld))throw Error('所有团队均无可交接结论，停止综合');
  }
  if(run.plan.mode==='debate'){
   for(let round=1;round<=(run.maxDebateRounds||run.debateRounds||1);round++){
    signal?.throwIfAborted();
    if(run.limit-run.calls.length<(run.debateMode==='auto'?9:8)){await warn('预算不足以开始完整下一轮并预留最终综合审查，提前结束辩论');run.debateStopReason='budget';break;}
    const snapshot=structuredClone(run.accepted),record={round,status:'running',before:snapshot,startedAt:new Date().toISOString(),results:{}};
    run.debateHistory.push(record);await event('debate_round_start','辩论第 '+round+' 轮：共享上一轮已审查结论',{round});
    const results=await Promise.allSettled(run.plan.roles.map(async r=>{
     const suffix=round===1?'':'-r'+round,messageId=r.id+'-debate'+suffix;
     const context={question:run.task,round,totalRounds:run.maxDebateRounds||run.debateRounds||1,focus:run.debateHistory.at(-2)?.assessment?.openIssues||[],identity:r.name,scope:r.scope,previous:snapshot[r.id],peers:Object.fromEntries(Object.entries(snapshot).filter(([id])=>id!==r.id))};
     const candidate=await ask(r.id+'-challenge'+suffix,r.name+' · 辩论第 '+round+' 轮',worker+prompts.debate,context,r.id,workerValid);
     return gate(messageId,r.name+' · 第 '+round+' 轮交接',candidate,context,(previous,issues)=>ask(messageId+'-repair-'+run.versions.filter(v=>v.messageId===messageId).length,r.name+' · 第 '+round+' 轮修订',worker,{...context,previous,requiredCorrections:issues},r.id,workerValid));
    }));
    signal?.throwIfAborted();
    for(const [i,result] of results.entries()){
     const role=run.plan.roles[i];
     if(result.status==='fulfilled'&&!result.value.withheld){run.accepted[role.id]=result.value;record.results[role.id]={status:'accepted',payload:result.value};}
     else{const reason=result.status==='rejected'?result.reason.message:'本轮候选未通过审查';record.results[role.id]={status:'retained_previous',reason};await warn(role.name+' 第 '+round+' 轮不可交接，保留上一轮已审查结论：'+reason);}
    }
    record.after=structuredClone(run.accepted);record.status='completed';record.finishedAt=new Date().toISOString();
    await event('debate_round_end','辩论第 '+round+' 轮完成',{round});
    if(run.debateMode==='auto'){
     if(run.limit-run.calls.length<3){run.debateStopReason='budget';await warn('剩余预算仅保留最终交付，停止辩论');break;}
     try{
      const assessment=await ask('debate-assess-'+round,'第 '+round+' 轮 · 是否继续辩论',
       prompts.debateAssessment,
       {question:run.task,round,before:record.before,after:record.after,evidenceSources:Object.fromEntries(Object.entries(record.after).map(([id,value])=>[id,{answer:value.answer,unresolved:value.unresolved||[],concerns:value.concerns||[]}])),previousAssessment:run.debateHistory.at(-2)?.assessment||null,branchStatus:record.results},undefined,x=>{
        if(!['continue','stop'].includes(x.decision)||!['stable','stalled','needs_external','progress'].includes(x.reasonCode)||typeof x.reason!=='string'||!x.reason.trim()||!Array.isArray(x.openIssues)||!Array.isArray(x.materialChanges)||!Array.isArray(x.unansweredChallenges))throw new OutputError('辩论评估字段无效');
        const values=v=>typeof v==='string'?[v]:v&&typeof v==='object'?Object.values(v).flatMap(values):[];const corpus=values(record.after).join('\n');
        for(const q of x.openIssues)if(!q||typeof q.id!=='string'||typeof q.issue!=='string'||typeof q.canResolveNow!=='boolean'||typeof q.nextStep!=='string'||typeof q.evidence!=='string'||q.evidence.trim().length<4||!corpus.includes(q.evidence))throw new OutputError('未解决问题缺少有效原文定位');
        if([...x.materialChanges,...x.unansweredChallenges].some(v=>typeof v!=='string'))throw new OutputError('进展描述须为字符串');return x;
       });
      record.assessment=assessment;
      const same=Object.keys(record.before).every(id=>record.before[id]?.answer===record.after[id]?.answer);
      const actionable=assessment.openIssues.some(x=>x.canResolveNow)||assessment.unansweredChallenges.length>0;
      let reason=same?'stalled':assessment.reasonCode;
      let stop=same||assessment.decision==='stop';
      if(!same&&reason==='progress')stop=false;
      if(!actionable&&reason==='needs_external')stop=true;
      if(round>=2&&!assessment.materialChanges.length&&run.debateHistory.at(-2)?.assessment?.materialChanges.length===0){stop=true;reason='stalled';}
      if(actionable&&!same&&(reason==='stable'||reason==='needs_external'||(reason==='stalled'&&round<2))){stop=false;reason='progress';}
      if(Object.values(record.results).some(x=>x.status!=='accepted')&&stop&&reason==='stable')reason='partial';
      record.stopCheck={stop,reason,modelDecision:assessment.decision};
      await event('debate_assessment','第 '+round+' 轮评估：'+(stop?'停止讨论':'继续下一轮'),{round,assessment,stopCheck:record.stopCheck});
      if(stop){run.debateStopReason=reason;if(reason!=='stable')await warn('自动结束辩论：'+assessment.reason+'；未解决问题保留在最终交付材料中');break;}
     }catch(e){signal?.throwIfAborted();run.debateStopReason='assessment_failed';await warn('进展评估不可用，停止追加辩论并保留已审查材料：'+e.message);break;}
    }
    if(round===(run.maxDebateRounds||run.debateRounds||1)){run.debateStopReason=run.debateMode==='auto'?'round_limit':'fixed_rounds';if(run.debateMode==='auto')await warn('达到自动辩论安全上限3轮，不代表所有分歧已解决');}

   }
  }
  const prompt=prompts.synthesis;
  const validDelivery=x=>{if(typeof x.executiveSummary!=='string'||!x.executiveSummary.trim()||!Array.isArray(x.actions)||x.actions.some(a=>typeof a!=='string'))throw new OutputError('最终交付字段无效');return x;};
  const draft=await ask('synthesis','综合交付',prompt,{question:run.task,accepted:run.accepted,warnings:run.warnings,debateRoundsCompleted:run.debateHistory.length,debateStopReason:run.debateStopReason,debateAssessments:run.debateHistory.map(x=>x.assessment).filter(Boolean)},undefined,validDelivery,5000);
  const delivery=await gate('synthesis','最终交付',draft,{accepted:run.accepted},(previous,issues)=>ask('synthesis-repair-'+run.versions.filter(v=>v.messageId==='synthesis').length,'最终交付 · 修订',prompt,{question:run.task,accepted:run.accepted,previous,requiredCorrections:issues},undefined,validDelivery,5000));
  if(delivery.withheld){run.status='needs_review';run.partial=run.accepted;run.error='最终候选仍有实质问题，保留已通过的团队结果，需人工复核';}
  else{run.delivery=delivery;run.status=run.warnings.length||Object.values(run.accepted).some(x=>x.withheld)?'completed_with_warnings':'completed';}
  await event(run.status,run.delivery?'已生成答案；审查建议与限制单独保留':'保留团队阶段结果，等待复核');
 }catch(e){run.status=signal?.aborted?'cancelled':'failed';run.error=e.message;run.partial=run.accepted;await event(run.status,e.message);}finally{run.finishedAt=new Date().toISOString();await emit();}
 return run;
}
