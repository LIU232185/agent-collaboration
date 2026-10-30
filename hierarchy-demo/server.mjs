import http from 'node:http';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {callModelDetailed,reloadModelEnvironment,modelStatus,modelConnectionInfo} from '../model-provider.mjs';
import {createLiveRun,executeRun,evolve,initialPolicy} from './runtime.mjs';
import {createPaperRun,executePaperRun,teams,modes} from './paper-runtime.mjs';
import {networkStatus} from '../model-network.mjs';
import {createAgentInvoker,loadAgentConfig,publicAgentConfig} from './agent-adapters.mjs';
const port=Number(process.env.HIERARCHY_PORT||4323),root=fileURLToPath(new URL('../',import.meta.url)),store=new URL('../data/hierarchy-v2/',import.meta.url);
await fs.mkdir(store,{recursive:true});await reloadModelEnvironment(root);
let externalAgents=await loadAgentConfig(root);
const customAgentFile=new URL('../data/hierarchy-v2/custom-agents.json',import.meta.url);
async function loadAllAgents(){const agents=await loadAgentConfig(root);try{Object.assign(agents,JSON.parse(await fs.readFile(customAgentFile,'utf8')));}catch(e){if(e.code!=='ENOENT')throw Error('自定义 Agent 配置不可读取');}return agents;}
externalAgents=await loadAllAgents();
const state={runs:[],experiments:[],connectionChecks:[],policy:initialPolicy};
try{Object.assign(state,JSON.parse(await fs.readFile(new URL('state.json',store),'utf8')));for(const r of [...state.runs,...state.experiments])if(r.status==='running'){r.status='interrupted';r.error='服务重启中断；未自动续费重试';}}catch(e){if(e.code!=='ENOENT')console.warn('历史记录不可读，使用初始状态');}
let active=null,controller=null,queue=Promise.resolve();
const persist=()=>{const data=JSON.stringify(state);queue=queue.catch(()=>{}).then(async()=>{await fs.writeFile(new URL('state.tmp',store),data);for(let attempt=0;;attempt++){try{await fs.rename(new URL('state.tmp',store),new URL('state.json',store));break;}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code)||attempt>=5)throw e;await new Promise(resolve=>setTimeout(resolve,100));}}});return queue;};
async function invokeModel(args,signal){return callModelDetailed(args,{signal});}
let invoke=createAgentInvoker({agents:externalAgents,modelInvoke:invokeModel});
const assets={'/':['console.html','text/html'],'/console.mjs':['console.mjs','text/javascript'],'/console.css':['console.css','text/css']};
http.createServer(async(req,res)=>{
 const json=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 try{
  const host=req.headers.host;if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host))return json(403,{error:'仅本机访问'});
  const url=new URL(req.url,`http://${host}`);
  if(req.method==='GET'&&url.pathname==='/api/state')return json(200,{...state,active,...modelStatus(),connection:modelConnectionInfo(),network:networkStatus(),registry:teams,externalAgents:publicAgentConfig(externalAgents),customAgents:Object.fromEntries(Object.entries(externalAgents).filter(([,a])=>a.mode==='internal').map(([id,a])=>[id,{id,name:a.name,instructions:a.instructions,enabled:a.enabled!==false}])),collaborationModes:modes});
  if(req.method==='GET'&&url.pathname==='/api/source'){const allow={'prompts.mjs':'prompts.mjs','paper-runtime.mjs':'paper-runtime.mjs','model-network.mjs':'../model-network.mjs','runtime.mjs':'runtime.mjs','server.mjs':'server.mjs','model-provider.mjs':'../model-provider.mjs'};const name=allow[url.searchParams.get('file')];if(!name)return json(404,{error:'源码不存在'});return json(200,{code:await fs.readFile(new URL(name,import.meta.url),'utf8')});}
  if(req.method==='POST'){
   if(req.headers.origin!==`http://${host}`)return json(403,{error:'仅允许页面同源提交'});
   let raw='';for await(const c of req){raw+=c;if(Buffer.byteLength(raw)>12000)return json(413,{error:'请求过大'});}const body=JSON.parse(raw||'{}');
   if(url.pathname==='/api/cancel'){controller?.abort();return json(200,{ok:true});}
   if(active)return json(409,{error:'已有执行任务，请等待或停止'});
   if(url.pathname==='/api/agents/save'){
    const id=String(body.id||''),name=String(body.name||'').trim(),instructions=String(body.instructions||'').trim();
    if(!['profile','hesitation','offer','measurement','permission','basis'].includes(id))return json(400,{error:'请选择有效的团队角色位'});
    if(!name||name.length>60||instructions.length<20||instructions.length>4000)return json(400,{error:'名称须为1–60字，职责说明须为20–4000字'});
    const custom={};for(const [key,value] of Object.entries(externalAgents))if(value.mode==='internal'&&key!==id)custom[key]=value;
    custom[id]={mode:'internal',name,instructions,enabled:body.enabled!==false};await fs.writeFile(customAgentFile,JSON.stringify(custom,null,2));
    externalAgents=await loadAllAgents();invoke=createAgentInvoker({agents:externalAgents,modelInvoke:invokeModel});return json(200,{ok:true,customAgents:Object.fromEntries(Object.entries(custom).map(([key,value])=>[key,{id:key,name:value.name,instructions:value.instructions,enabled:value.enabled}]))});
   }
   if(url.pathname==='/api/agents/test'){
    const name=String(body.name||'自定义 Agent').slice(0,60),instructions=String(body.instructions||'').trim(),task=String(body.task||'').trim();if(instructions.length<20||instructions.length>4000||!task||task.length>2000)return json(400,{error:'请提供职责说明（20–4000字）和测试任务（1–2000字）'});
    if(!modelStatus().configured)return json(400,{error:'请先配置模型 API'});
    const result=await invokeModel({instructions:`你是“${name}”。\n${instructions}\n\n只返回 JSON：{answer:string,assumptions:string[],limitations:string[]}`,input:JSON.stringify({task}),jsonMode:true,maxOutputTokens:1200});
    let output;try{output=JSON.parse(result.text);}catch{return json(502,{error:'Agent 返回内容不是有效 JSON',raw:result.text});}return json(200,{output,usage:result.usage||null,model:result.model});
   }
   if(url.pathname==='/api/reload'){const status=await reloadModelEnvironment(root);externalAgents=await loadAllAgents();invoke=createAgentInvoker({agents:externalAgents,modelInvoke:invokeModel});return json(200,{...status,externalAgents:publicAgentConfig(externalAgents)});}
   if(url.pathname==='/api/probe'){
    if(!modelStatus().configured||modelStatus().provider!=='deepseek')return json(400,{error:'需要已配置的 DeepSeek API'});
    const record={id:crypto.randomUUID(),status:'running',startedAt:new Date().toISOString()};state.connectionChecks.unshift(record);state.connectionChecks=state.connectionChecks.slice(0,5);active='api-probe';controller=new AbortController();const started=Date.now();
    try{const result=await invoke({instructions:'只返回 JSON 对象 {"ok":true}，不输出其他内容。',input:'API connectivity check',jsonMode:true},controller.signal);Object.assign(record,result,{status:'done'});json(200,{ok:true,id:record.id});}catch(e){Object.assign(record,e.metadata||{},{status:'failed',error:e.message});json(400,{error:e.message});}finally{record.latencyMs=Date.now()-started;active=null;controller=null;await persist();}return;
   }
   if(url.pathname==='/api/activate'){
    const exp=state.experiments.find(x=>x.id===body.id);if(!exp?.eligible||exp.status!=='completed')return json(400,{error:'仅允许启用已评测通过的候选'});state.policy=exp.candidate;await persist();return json(200,{policy:state.policy});
   }
   if(url.pathname==='/api/rollback'){state.policy=initialPolicy;await persist();return json(200,{policy:state.policy});}
   if(!['/api/start','/api/evolve'].includes(url.pathname))return json(404,{error:'接口不存在'});
   if(!modelStatus().configured)return json(400,{error:'本地 API 未配置，请检查项目 .env'});
   if(url.pathname==='/api/start'){
    if(modelStatus().provider!=='deepseek')return json(400,{error:'此入口要求真实 DeepSeek API'});
    const run=createPaperRun({task:body.task,model:modelStatus().model,collaboration:body.collaboration,router:body.router,debateRounds:body.debateRounds,debateMode:body.debateMode,chainOrder:body.chainOrder});state.runs.unshift(run);state.runs=state.runs.slice(0,20);controller=new AbortController();active=run.id;await persist();json(202,{id:run.id});
    void executePaperRun(run,{invoke,emit:persist,signal:controller.signal}).catch(e=>{run.status='failed';run.error=e.message;}).finally(async()=>{active=null;controller=null;await persist();});return;
   }
   const source=state.runs.find(r=>r.kind!=='paper-live'&&r.id===body.id&&['completed','blocked'].includes(r.status));if(!source)return json(400,{error:'请选择已完成或已阻断的真实运行作为证据'});
   controller=new AbortController();const signal=controller.signal;active='evolution';json(202,{ok:true});
   let record;void evolve({source,invoke:args=>invoke(args,signal),emit:async r=>{if(!record){record=r;state.experiments.unshift(r);state.experiments=state.experiments.slice(0,10);}await persist();}}).catch(e=>{if(record){record.status='failed';record.error=e.message;}}).finally(async()=>{active=null;controller=null;await persist();});return;
  }
  const asset=assets[url.pathname];if(req.method!=='GET'||!asset)return json(404,{error:'不存在'});
  const body=await fs.readFile(new URL(asset[0],import.meta.url));res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});res.end(body);
 }catch(e){json(400,{error:e.message});}
}).listen(port,'127.0.0.1',()=>console.log(`层间技术控制台：http://127.0.0.1:${port}`));
