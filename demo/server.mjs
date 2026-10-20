import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {planner,coder,tester,sources,requirement} from './demo.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const port=4321;
let current=null;
let busy=false;
const assets={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
async function persist(){
  const {directory,...record}=current;
  await fs.writeFile(path.join(directory,'trace.json'),JSON.stringify(record,null,2));
}
async function start(maxRounds){
  await fs.mkdir(path.join(root,'runs'),{recursive:true});
  const directory=await fs.mkdtemp(path.join(root,'runs','visual-'));
  current={id:crypto.randomUUID(),directory,mode:'offline-scripted-roles',requirement,
    status:'running',stage:'baseline',round:0,maxRounds,events:[],source:sources[0],createdAt:new Date().toISOString()};
  const plan=planner(requirement);
  plan.max_rounds=maxRounds;
  current.plan=plan;
  current.events.push({...plan,at:new Date().toISOString()});
  await fs.writeFile(path.join(directory,'todo.mjs'),sources[0]);
  await persist();
}
async function step(){
  if(current.status!=='running')return;
  if(current.stage==='baseline'||current.stage==='test'){
    const feedback=await tester(current.directory,{task_id:current.plan.task_id,round:current.round});
    current.feedback=feedback;
    current.events.push({...feedback,at:new Date().toISOString()});
    if(feedback.status==='passed'||(current.round>=current.maxRounds)){
      current.status=feedback.status==='passed'?'completed':'failed';
      current.stage='finished';
      current.events.push({from:'调度程序',to:'用户',status:current.status,
        reason:current.status==='completed'?'四项验收全部通过，交付最终代码。':'达到修复轮数上限，仍有失败项，停止并保留证据。',at:new Date().toISOString()});
    }else current.stage='code';
  }else if(current.stage==='code'){
    current.round++;
    const handoff=coder(current.plan,current.feedback,current.round);
    current.source=handoff.source;
    current.events.push({...handoff,at:new Date().toISOString()});
    await fs.writeFile(path.join(current.directory,'todo.mjs'),current.source);
    current.stage='test';
  }
  await persist();
}
http.createServer(async(req,res)=>{
  const json=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  try{
    const host=req.headers.host;
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host))return json(403,{error:'请从本机地址访问'});
    if(req.method==='GET'&&req.url==='/api/state')return json(200,{run:current,busy});
    if(req.method==='POST'){
      if(req.headers.origin!==`http://${host}`)return json(403,{error:'请从演示页面操作'});
      if(!['/api/start','/api/step'].includes(req.url))return json(404,{error:'接口不存在'});
      if(busy)return json(409,{error:'上一步正在执行，请稍后再试'});
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>2048)return json(413,{error:'请求过大'});}
      const body=JSON.parse(raw||'{}');
      if(req.url==='/api/start'&&![1,2].includes(body.maxRounds))return json(400,{error:'修复轮数须为 1 或 2'});
      if(req.url==='/api/step'&&(!current||body.id!==current.id))return json(409,{error:'任务已变化，请刷新页面'});
      busy=true;
      try{
        if(req.url==='/api/start')await start(body.maxRounds);else await step();
        return json(200,{run:current});
      }catch(error){
        if(current){current.status='error';current.stage='finished';current.events.push({from:'系统',to:'用户',status:'error',reason:error.message,at:new Date().toISOString()});await persist().catch(()=>{});}
        throw error;
      }finally{busy=false;}
    }
    const asset=assets[req.url];
    if(req.method!=='GET'||!asset)return json(404,{error:'页面不存在'});
    res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8','Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});
    res.end(await fs.readFile(path.join(root,'ui',asset[0])));
  }catch(error){json(400,{error:error.message});}
}).listen(port,'127.0.0.1',()=>console.log(`多智能体可视化实验室：http://127.0.0.1:${port}`));
