import {setTimeout as delay} from 'node:timers/promises';

export const protectionNames={none:'无防护',challenger:'Challenger 质疑',inspector:'Inspector 检查',both:'质疑 + 检查'};

export function validateExperiment(config){
  if(!config||!['none','wrong_total','missing_basis'].includes(config.fault)||!Object.hasOwn(protectionNames,config.protection)||![0,1].includes(config.maxRetries))throw Error('容错实验配置无效');
  for(const key of ['quantity','unitPrice'])if(!Number.isSafeInteger(config[key])||config[key]<1||config[key]>100000)throw Error('数量和单价须为 1–100000 的整数');
  return {...config};
}

// The checker only receives the task and a candidate; it cannot read injection flags.
export function checkCandidate(task,candidate){
  const expected=task.quantity*task.unitPrice,issues=[];
  if(!candidate||candidate.quantity!==task.quantity||candidate.unitPrice!==task.unitPrice)issues.push('计算依据缺失或与原始题目不一致');
  if(candidate?.total!==expected)issues.push(`金额不符：按原题独立验算应为 ${expected} 元`);
  return {passed:issues.length===0,issues};
}

export function createResilienceRun(config){
  config=validateExperiment(config);
  const inspector=['inspector','both'].includes(config.protection);
  const ids=inspector?['researcher','practitioner','inspector','reviewer','summary']:['researcher','practitioner','reviewer','summary'];
  const names={researcher:'题目解析员',practitioner:'计算员',inspector:'独立检查器',reviewer:'接收审查员',summary:'汇总员'};
  const tasks={researcher:'从原始题目读取数量与单价',practitioner:'计算总价，出现问题时按原始输入重算',inspector:'交接前独立验算；异常消息先隔离',reviewer:config.protection==='challenger'||config.protection==='both'?'使用上游结果前质疑并独立验算':'对照组：直接使用上游结果，不做验算',summary:'交付接收方接受的金额；最后由外部验算器评测'};
  return {id:crypto.randomUUID(),kind:'resilience',question:`采购 ${config.quantity} 件商品，每件 ${config.unitPrice} 元，总价是多少？`,backend:'demo',model:'本地确定性算术 · 零模型调用',
    status:'running',createdAt:new Date().toISOString(),finishedAt:null,events:[],result:'',error:null,
    plan:{mode:'chain',edges:ids.slice(1).map((id,i)=>[ids[i],id]),reason:`容错实验：${protectionNames[config.protection]}`,controller:'rule-based',modelRouting:'规则实现的机制实验；不是论文基准或 LLM 防御效果'},
    nodes:ids.map(id=>({id,name:names[id],task:tasks[id],status:'waiting',input:'',output:'',startedAt:null,finishedAt:null})),
    resilience:{config,versions:[],audit:null,comparison:[],comparisonTrials:[],retries:0,contaminatedHandoffs:0,detected:false,recovered:false},
  };
}

export async function executeResilience(run,{onChange=async()=>{},interval=650,signal,compare=true}={}){
  const r=run.resilience,c=r.config,task={quantity:c.quantity,unitPrice:c.unitPrice};
  const node=id=>run.nodes.find(n=>n.id===id),format=x=>JSON.stringify(x,null,2);
  const record=async(type,data={})=>{run.events.push({id:run.events.length+1,type,at:new Date().toISOString(),...data});await onChange(run);};
  const wait=async()=>{if(signal?.aborted)throw Error('任务已停止');if(interval)await delay(interval,undefined,{signal});};
  const start=async(id,input)=>{const n=node(id);n.status='running';n.input=typeof input==='string'?input:format(input);n.startedAt=new Date().toISOString();await record('start',{node:id,message:`${n.name}开始处理`});await wait();};
  const finish=async(id,value)=>{const n=node(id);n.output=typeof value==='string'?value:format(value);n.status='done';n.finishedAt=new Date().toISOString();await record('complete',{node:id,message:`${n.name}已交付`,content:n.output});};
  const handoff=async(from,to,value)=>{
    const audit=checkCandidate(task,value);
    if(!audit.passed&&from!=='researcher')r.contaminatedHandoffs++;
    await record('handoff',{from,to,message:`${node(from).name} → ${node(to).name}`,content:format(value),messageVersion:r.versions.at(-1)?.id||null,verification:audit.passed?'符合原题':'不符合原题'});
  };
  const version=(payload,reason)=>{const v={id:`v${r.versions.length+1}`,parent:r.versions.at(-1)?.id||null,reason,payload:structuredClone(payload)};r.versions.push(v);return payload;};
  const repair=async(candidate,checker)=>{
    const verdict=checkCandidate(task,candidate);
    await record('inspection',{node:checker,message:`${node(checker).name}：${verdict.passed?'验算通过':'发现异常'}`,content:format(verdict)});
    if(verdict.passed)return candidate;
    r.detected=true;node('practitioner').status='quarantined';
    await record('quarantine',{node:'practitioner',from:'practitioner',to:checker,message:'隔离异常消息，暂停向下游推进',content:format(candidate)});
    if(r.retries>=c.maxRetries){const error=Error('修复预算耗尽；异常消息未获放行');error.blocked=true;throw error;}
    r.retries++;
    await record('challenge',{node:checker,from:checker,to:'practitioner',message:`${node(checker).name}质疑并退回重算（${r.retries}/${c.maxRetries}）`,content:format({issues:verdict.issues,originalTask:task})});
    await start('practitioner',{originalTask:task,issues:verdict.issues});
    // A fresh deterministic calculation from original inputs, not a saved answer rollback.
    const revised=version({...task,total:task.quantity*task.unitPrice},'依据原题重算');
    await finish('practitioner',revised);
    const checked=checkCandidate(task,revised);
    await record('recheck',{node:checker,message:'重算后再次独立验算',content:format(checked)});
    if(!checked.passed){const error=Error('重算结果仍不合格');error.blocked=true;throw error;}
    r.recovered=true;await record('recovered',{node:'practitioner',message:'新版本通过验算，恢复状态推进',content:format(revised)});
    return revised;
  };
  try{
    await record('route',{message:run.plan.reason});
    await start('researcher',run.question);await finish('researcher',task);
    await handoff('researcher','practitioner',task);await start('practitioner',task);
    let candidate=version({...task,total:task.quantity*task.unitPrice},'计算员原始计算');
    if(c.fault!=='none'){
      const original=structuredClone(candidate);
      candidate=c.fault==='wrong_total'?{...candidate,total:candidate.total+c.unitPrice}:{total:candidate.total};
      candidate=version(candidate,c.fault==='wrong_total'?'受控金额篡改':'受控依据删除');
      await record('fault',{node:'practitioner',message:c.fault==='wrong_total'?'注入故障：总价多算一件':'注入故障：删除数量与单价依据',content:format({before:original,after:candidate})});
    }
    await finish('practitioner',candidate);
    if(node('inspector')){
      await handoff('practitioner','inspector',candidate);await start('inspector',{originalTask:task,candidate});
      candidate=await repair(candidate,'inspector');await finish('inspector',candidate);
      await handoff('inspector','reviewer',candidate);
    }else await handoff('practitioner','reviewer',candidate);
    await start('reviewer',{originalTask:task,candidate});
    if(['challenger','both'].includes(c.protection))candidate=await repair(candidate,'reviewer');
    else await record('accept',{node:'reviewer',message:'接收方直接采用上游内容（未启用 Challenger）',content:format(candidate)});
    await finish('reviewer',candidate);await handoff('reviewer','summary',candidate);
    await start('summary',candidate);await finish('summary',`交付总价：${candidate.total} 元。`);
    // External scoring happens after final delivery; it does not repair the baseline.
    r.audit={...checkCandidate(task,candidate),expectedTotal:task.quantity*task.unitPrice,actualTotal:candidate.total};
    run.result=node('summary').output+`\n\n外部验算：${r.audit.passed?'通过':'未通过'}。\n原题正确总价：${r.audit.expectedTotal} 元。\n${r.audit.issues.join('；')}`;
    run.status='done';await record('audit',{message:`最终外部验算：${r.audit.passed?'通过':'失败'}`,content:format(r.audit)});
  }catch(error){
    run.status=signal?.aborted?'cancelled':error.blocked?'blocked':'failed';run.error=signal?.aborted?'你已停止任务':error.message;
    for(const n of run.nodes)if(n.status==='running')n.status=run.status==='blocked'?'blocked':run.status==='cancelled'?'cancelled':'failed';else if(n.status==='waiting')n.status='skipped';
    await record('error',{message:run.error});
  }
  run.finishedAt=new Date().toISOString();
  if(compare&&run.status!=='cancelled'&&run.status!=='failed'){
    for(const protection of Object.keys(protectionNames)){
      if(signal?.aborted)break;
      const trial=createResilienceRun({...c,protection});
      await executeResilience(trial,{interval:0,compare:false,signal});
      r.comparisonTrials.push(trial);
      r.comparison.push({protection,status:trial.status,detected:trial.resilience.detected,recovered:trial.resilience.recovered,contaminatedHandoffs:trial.resilience.contaminatedHandoffs,actualTotal:trial.resilience.audit?.actualTotal??null,passed:trial.resilience.audit?.passed??false,retries:trial.resilience.retries});
    }
  }
  await record('finished',{message:run.status==='done'?'容错实验与四组对照运行完成':'任务已停止推进'});
  return run;
}
