export const teams = [
  {id:'customer',name:'摇摆户 Agent',subtitle:'识别客户为什么犹豫',children:[['profile','画像子 Agent','整理客户意向与约束'],['hesitation','犹豫分析子 Agent','定位价格、信任或时机因素'],['segment','分层子 Agent','输出客群标签与可交接证据']]},
  {id:'marketing',name:'营销 Agent',subtitle:'把客户需求变成候选方案',children:[['offer','方案子 Agent','选择匹配需求的方案'],['copy','话术子 Agent','生成说明与联系计划'],['revise','修订子 Agent','根据风控反馈修改方案']]},
  {id:'risk',name:'风控 Agent',subtitle:'检查方案并决定放行或退回',children:[['permission','授权检查子 Agent','检查联系授权'],['promise','承诺检查子 Agent','检查未证实的承诺'],['gate','决策子 Agent','汇总检查结果并给出处理意见']]},
];
export const fixtures = {
  price:{name:'价格犹豫 · 可恢复',customer:'客户 A（虚构）',intent:72,budget:300,price:399,consent:true,reason:'有明确需求，但认为 399 元超出预算，希望先了解基础服务。'},
  trust:{name:'信任犹豫 · 独立验证',customer:'客户 B（虚构）',intent:68,budget:450,price:399,consent:true,reason:'预算足够，但担心效果，希望先了解服务边界和可核实的材料。'},
  denied:{name:'无联系授权 · 应当阻断',customer:'客户 C（虚构）',intent:80,budget:450,price:399,consent:false,reason:'有需求，但没有授权营销联系；意向高不代表允许联系。'},
};
export const baselinePolicy = {version:1,precheck:false,source:'初始预设策略'};
const clone=x=>structuredClone(x);
export function simulate({scenario='price',fault=true,protection=true,budget=1,policy=baselinePolicy}={}) {
  if(!fixtures[scenario]||![0,1].includes(budget))throw Error('无效案例或恢复预算');
  const customer=clone(fixtures[scenario]), events=[];
  const add=(level,from,to,title,input,output,extra={})=>events.push({id:events.length+1,level,from,to,title,input:clone(input),output:clone(output),...extra});
  const options={scenario,fault,protection,budget,policy:clone(policy)};
  add('control','scheduler','customer','调度器选择固定业务流程',customer,{route:['摇摆户','营销','风控'],policy:policy.version,reason:'客户分析结果是营销输入，候选方案必须经过风控；这里使用预设规则，不是训练后的路由器。'});
  add('internal','customer','profile','① 画像子 Agent 读取客户',customer,{intent:customer.intent,budget:customer.budget,consent:customer.consent});
  add('internal','profile','hesitation','② 犹豫分析子 Agent 定位原因',{reason:customer.reason},{category:scenario==='price'?'价格':scenario==='trust'?'信任':'授权缺失',evidence:customer.reason});
  const brief={customer:customer.customer,segment:scenario==='price'?'高意向 / 预算敏感':scenario==='trust'?'高意向 / 证据敏感':'不可主动营销',budget:customer.budget,consent:customer.consent,evidence:customer.reason};
  add('internal','hesitation','segment','③ 分层子 Agent 形成分析摘要',customer,brief);
  add('top','customer','marketing','顶层交接：摇摆户 → 营销',brief,{accepted:true,task:'生成候选方案，保留授权与需求依据'});
  if(policy.precheck){
    add('control','marketing','permission','进化后的策略：方案生成前先查授权与禁用承诺',brief,{allowed:customer.consent,rule:'先核对授权；生成时排除未经证实的保证性承诺。'});
    if(!customer.consent){
      add('control','permission','scheduler','提前阻断：缺少联系授权',brief,{status:'blocked',action:'不生成联系话术，不发起联系；等待独立授权。'});
      return finish('blocked',null,0);
    }
  }
  let candidate={version:1,product:scenario==='price'?'基础服务':'标准服务',price:scenario==='price'?299:399,consent:customer.consent,guaranteed:!!fault&&!policy.precheck,copy:'先介绍服务内容、价格与适用边界，由客户自主决定。'};
  add('internal','marketing','offer','① 方案子 Agent 匹配产品',brief,{product:candidate.product,price:candidate.price,reason:'价格案例选择预算内基础服务；信任案例保留标准服务并补充说明。'});
  if(candidate.guaranteed)candidate.copy='保证达到预期效果，今天立即购买！';
  add('internal','offer','copy','② 话术子 Agent 输出候选方案',{brief,faultRequested:fault},candidate,{fault:candidate.guaranteed});
  add('top','marketing','risk','顶层交接：营销 → 风控',candidate,{task:'检查原始授权、预算与承诺；没有实际联系客户。'});
  const issuesFor=x=>[...(!customer.consent?['原始客户没有联系授权']:[]),...(x.price>customer.budget?['方案超过预算']:[]),...(x.guaranteed?['包含未证实的效果保证']:[])];
  if(!protection){
    add('internal','risk','gate','对照组：关闭交接检查，直接接受',candidate,{accepted:true,note:'这是受控对照，不表示真实风控应当这样运行。'});
    add('top','risk','scheduler','顶层交接：风控 → 调度器',candidate,{status:'delivered',candidate});
    return finish('delivered',candidate,0);
  }
  add('internal','risk','permission','① 授权子 Agent 核对原始资料',{originalConsent:customer.consent,candidateConsent:candidate.consent},{passed:customer.consent,reason:customer.consent?'具备模拟授权记录':'无联系授权，不能通过修改话术获得授权'});
  add('internal','risk','promise','② 承诺子 Agent 检查候选消息',candidate,{passed:!candidate.guaranteed,issues:issuesFor(candidate)});
  let issues=issuesFor(candidate);
  add('internal','promise','gate','③ 决策子 Agent 汇总检查',{candidate,issues},{decision:issues.length?'退回或阻断':'放行',issues});
  if(issues.length){
    if(!customer.consent||budget===0){
      add('top','risk','scheduler','顶层阻断：不再推进', {candidate,issues},{status:'blocked',reason:!customer.consent?'缺少外部授权，不能由 agent 自行补造':'恢复预算为 0',candidateRejected:true});
      return finish('blocked',candidate,0);
    }
    add('top','risk','marketing','顶层反馈：风控 → 营销，退回修改',{candidate,issues},{instruction:'保留客户依据，删除效果保证，明确服务边界',remainingRetries:budget});
    const previous=clone(candidate);
    candidate={...candidate,version:2,guaranteed:false,copy:'可先了解服务范围与可核实的案例；效果因实际条件而异，由客户自主决定。'};
    add('internal','marketing','revise','③ 修订子 Agent 生成新版本',{previous,issues},candidate);
    add('top','marketing','risk','顶层交接：营销 → 风控，提交 v2',candidate,{issues:issuesFor(candidate),passed:issuesFor(candidate).length===0});
    add('internal','risk','gate','风控重新验收 v2',candidate,{passed:issuesFor(candidate).length===0,checks:['原始授权','预算约束','无保证性承诺']});
  }
  add('top','risk','scheduler','顶层放行：风控 → 调度器',candidate,{status:'delivered',meaning:'候选方案通过本例规则，尚未联系任何客户。'});
  return finish('delivered',candidate,candidate.version-1);
  function finish(status,candidate,retries){
    const issues=candidate?issuesForFinal(candidate):[];
    const audit={passed:status==='delivered'&&issues.length===0,issues,blocked:status==='blocked',note:'独立于交接防护的最终规则验收；仅评价，不修正交付。'};
    add('evaluation','evaluator','scheduler','外部验收：检查最终状态',{status,candidate},{...audit,meaning:status==='blocked'?'已阻断；不计为交付成功':audit.passed?'本例规则通过；不代表实际转化或业务效果':'出现不合格交付'});
    return {id:crypto.randomUUID(),createdAt:new Date().toISOString(),options,customer,events,status,candidate,retries,audit,policyVersion:policy.version};
  }
  function issuesForFinal(x){return [...(!customer.consent?['未经授权']:[]),...(x.price>customer.budget?['超出预算']:[]),...(x.guaranteed?['未证实承诺']:[])];}
}
export function proposePolicy(run){
  if(!run.events.some(e=>e.fault))return null;
  return {version:2,precheck:true,source:`任务 ${run.id} 发现候选话术包含未证实承诺`,change:'在营销生成前检查授权，并在生成规则中排除保证性承诺。'};
}
export function validatePolicy(policy){
  const checks=['price','trust','denied'].map(scenario=>{
    const before=simulate({scenario,fault:true,protection:true,policy:baselinePolicy});
    const after=simulate({scenario,fault:true,protection:true,policy});
    const passed=scenario==='denied'?after.status==='blocked':after.audit.passed;
    return {scenario:fixtures[scenario].name,beforeRetries:before.retries,afterRetries:after.retries,status:after.status,passed};
  });
  return {passed:checks.every(c=>c.passed),checks,note:'三个人工固定用例的回归检查，不是独立真实数据集，也不能证明泛化提升。'};
}
