import fs from 'node:fs/promises';
import path from 'node:path';

const ids=new Set(['customer','marketing','risk','profile','hesitation','offer','measurement','permission','basis']);
export async function loadAgentConfig(root){
 let parsed={};try{parsed=JSON.parse(await fs.readFile(path.join(root,'agents.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('agents.json 无法读取或 JSON 格式无效');}
 const agents=parsed.agents||{};
 for(const [id,a] of Object.entries(agents)){
  if(!ids.has(id)||!a||typeof a.url!=='string')throw Error(`外部 Agent 配置无效：${id}`);
  const u=new URL(a.url);if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw Error(`${id} 的 URL 必须使用 HTTPS（本机测试可用 HTTP）`);
  if(a.apiKeyEnv&& !/^[A-Z][A-Z0-9_]*$/.test(a.apiKeyEnv))throw Error(`${id} 的 apiKeyEnv 无效`);
 }
 return agents;
}
export function publicAgentConfig(agents){return Object.fromEntries(Object.entries(agents).map(([id,a])=>[id,{url:a.url,enabled:a.enabled!==false,protocol:a.protocol||'http-json'}]));}
export function createAgentInvoker({agents={},env=process.env,modelInvoke,fetchImpl=fetch}){
 return async(args,signal)=>{
  const id=args.team,agent=agents[id];if(!agent||agent.enabled===false)return modelInvoke(args,signal);
  if(agent.mode==='internal')return modelInvoke({...args,instructions:`${agent.instructions||''}\n\n当前任务要求：\n${args.instructions}`},signal);
  const team={profile:'customer',hesitation:'customer',offer:'marketing',measurement:'marketing',permission:'risk',basis:'risk'}[id];
  const key=agent.apiKeyEnv?env[agent.apiKeyEnv]:'';
  const timer=AbortSignal.timeout(Math.min(Math.max(agent.timeoutMs||60000,1000),180000));
  let response;try{response=await fetchImpl(agent.url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(key?{Authorization:`Bearer ${key}`}:{})},body:JSON.stringify({protocol:'agent-collaboration.v1',task_id:args.callId||null,agent_id:team,subagent_id:id,instructions:args.instructions,input:args.input,json_mode:args.jsonMode===true,max_output_tokens:args.maxOutputTokens}),signal:signal?AbortSignal.any([signal,timer]):timer});}
  catch(e){if(signal?.aborted)throw Error('外部 Agent 请求已取消');throw Error(`外部 Agent ${id} 连接失败或超时：${e.message}`);}
  if(!response.ok)throw Error(`外部 Agent ${id} 返回 HTTP ${response.status}`);
  let body;try{body=await response.json();}catch{throw Error(`外部 Agent ${id} 返回无效 JSON`);}
  const text=typeof body==='string'?body:body.output??body.text??body.result;
  if(typeof text!=='string')throw Error(`外部 Agent ${id} 响应须包含 output、text 或 result 字符串`);
  return {text,provider:'external-agent',model:agent.name||id,usage:body.usage||null,httpStatus:response.status,responseId:typeof body.request_id==='string'?body.request_id.slice(0,160):null,receivedAt:new Date().toISOString(),endpoint:agent.url};
 };
}
