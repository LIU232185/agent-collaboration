import fs from 'node:fs/promises';
import path from 'node:path';
import {parseEnv} from 'node:util';
import {configureNetwork,networkStatus} from './model-network.mjs';
import {apiRequest} from './model-transport.mjs';

const fields=['LLM_PROVIDER','DEEPSEEK_API_KEY','DEEPSEEK_MODEL','DEEPSEEK_BASE_URL','OPENAI_API_KEY','OPENAI_MODEL','OPENAI_BASE_URL','LLM_NETWORK_MODE','LLM_PROXY_URL','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','https_proxy','http_proxy','no_proxy'];
let localEnvironment={};
export function modelConfig(env={...process.env,...localEnvironment}){
  const provider=env.LLM_PROVIDER||(env.DEEPSEEK_API_KEY?'deepseek':'openai');
  if(!['deepseek','openai'].includes(provider))throw Error('LLM_PROVIDER 仅支持 deepseek 或 openai');
  const deepseek=provider==='deepseek';
  const key=(env[deepseek?'DEEPSEEK_API_KEY':'OPENAI_API_KEY']||'').trim();
  const model=(env[deepseek?'DEEPSEEK_MODEL':'OPENAI_MODEL']||(deepseek?'deepseek-flash':'')).trim();
  const base=(env[deepseek?'DEEPSEEK_BASE_URL':'OPENAI_BASE_URL']||(deepseek?'https://api.deepseek.com':'https://api.openai.com/v1')).replace(/\/+$/,'');
  let url;try{url=new URL(base);}catch{throw Error('模型 API 地址无效');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('模型 API 地址须为无凭据、无查询参数的 HTTPS 地址');
  return {provider,key,model,base,configured:!!(key&&model)};
}
export function modelStatus(){const {provider,model,configured}=modelConfig();return {provider,model,configured};}
export function modelConnectionInfo(){const c=modelConfig();return {endpoint:`${c.base}/${c.provider==='deepseek'?'chat/completions':'responses'}`,transport:'HTTPS'};}
export async function reloadModelEnvironment(root){
  let parsed;try{parsed=parseEnv(await fs.readFile(path.join(root,'.env'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('无法读取本地 .env 配置');parsed={};}
  const next=Object.fromEntries(fields.filter(k=>Object.hasOwn(parsed,k)).map(k=>[k,parsed[k]]));
  modelConfig({...process.env,...next});
  await configureNetwork({...process.env,...next});
  localEnvironment=next;return modelStatus();
}

export async function callModel({instructions,input,jsonMode=false,maxOutputTokens=3000},{env,fetchImpl=apiRequest,signal,onMetadata}={}){
  const config=modelConfig(env);
  if(!config.configured)throw Error(config.provider==='deepseek'?'请在本地 .env 填写 DEEPSEEK_API_KEY':'请在本地 .env 设置 OPENAI_API_KEY 和 OPENAI_MODEL');
  const deepseek=config.provider==='deepseek';
  if(!Number.isInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>5000)throw Error('输出 token 预算须为 1–5000 的整数');
  const payload=deepseek?{model:config.model,messages:[{role:'system',content:instructions},{role:'user',content:input}],thinking:{type:'disabled'},stream:false,max_tokens:maxOutputTokens,...(jsonMode?{response_format:{type:'json_object'}}:{})}:{model:config.model,instructions,input,store:false,max_output_tokens:maxOutputTokens};
  let response;
  try{const timeout=AbortSignal.timeout(180000);response=await fetchImpl(`${config.base}/${deepseek?'chat/completions':'responses'}`,{method:'POST',headers:{Authorization:`Bearer ${config.key}`,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:signal?AbortSignal.any([timeout,signal]):timeout,redirect:'error'});}
  catch(error){if(signal?.aborted)throw Error('模型请求已取消');const code=error.cause?.code||error.code;throw Error(`模型 API 连接失败或超时${code&&/^[A-Z_0-9]+$/.test(code)?'（'+code+'）':''}；当前网络路径为 ${networkStatus().route}，请检查 VPN、代理端口或 API 地址。未自动重试。`);}
  if(!response.ok)throw Error(`模型 API 请求失败（HTTP ${response.status}），检查密钥、模型权限或配额`);
  let body;try{body=await response.json();}catch{throw Error('模型 API 返回了无效 JSON');}
  onMetadata?.({usage:body.usage||null,model:body.model||config.model,provider:config.provider,network:networkStatus(),httpStatus:response.status,responseId:typeof body.id==='string'?body.id.slice(0,160):null,receivedAt:new Date().toISOString(),endpoint:`${config.base}/${deepseek?'chat/completions':'responses'}`});
  if(deepseek){
    const choice=body.choices?.[0];
    if(choice?.finish_reason&&choice.finish_reason!=='stop')throw Error(`模型未完整完成（${['length','tool_calls','content_filter'].includes(choice.finish_reason)?choice.finish_reason:'非正常停止'}），本次输出不向下游传递`);
    const output=choice?.message?.content;
    if(typeof output!=='string'||!output.trim())throw Error('模型 API 未返回正文');
    return output;
  }
  if(body.status&&body.status!=='completed')throw Error('模型未完整完成，本次输出不向下游传递');
  const output=(body.output??[]).flatMap(x=>x.content??[]).filter(x=>x.type==='output_text').map(x=>x.text).join('\n');
  if(!output)throw Error('API 未返回文本');return output;
}

export async function callModelDetailed(args,options={}){let metadata={};try{const text=await callModel(args,{...options,onMetadata:data=>{metadata=data;options.onMetadata?.(data);}});return {text,...metadata};}catch(error){error.metadata=metadata;throw error;}}
