import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Lab} from './lab.mjs';
import {modelStatus} from './model-provider.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const lab=await new Lab().init();
let busy=false;
const jobs=[];
async function records(kind){
  const dir=path.join(root,'data',kind);
  return (await Promise.all((await fs.readdir(dir)).filter(n=>n.endsWith('.json')).map(async n=>{try{return JSON.parse(await fs.readFile(path.join(dir,n),'utf8'));}catch{return null;}}))).filter(Boolean).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
const server=http.createServer(async(req,res)=>{
  const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  try{
    const host=req.headers.host;
    if(!['127.0.0.1:4317','localhost:4317'].includes(host))return send(403,{error:'无效的主机地址'});
    if(req.method==='POST' && req.headers.origin!==`http://${host}`)return send(403,{error:'仅允许本地工作台提交'});
    if(req.method==='GET' && req.url==='/api/state')return send(200,{agents:lab.agents,runs:await records('runs'),lessons:await records('lessons'),jobs,busy,...modelStatus()});
    if(req.method==='GET' && req.url.startsWith('/api/files?')){
      const q=new URL(req.url,`http://${host}`).searchParams;const id=q.get('agent'),kind=q.get('kind');lab.agent(id);
      if(!['knowledge','skills','memory'].includes(kind))throw Error('无效资料类别');
      const files=[];for(const name of await fs.readdir(lab.dir(id,kind))){const p=path.join(lab.dir(id,kind),name);if(name.endsWith('.md')&&(await fs.lstat(p)).isFile())files.push({name,content:await fs.readFile(p,'utf8')});}
      return send(200,{files});
    }
    if(req.method==='POST' && req.url.startsWith('/api/')){
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>150000)return send(413,{error:'内容过大'});}
      const body=JSON.parse(raw||'{}');
      if(busy)return send(409,{error:'当前任务运行中，请完成后再操作'});
      if(req.url==='/api/agents'){
        const a=lab.agent(body.id);
        if(typeof body.role!=='string'||!body.role.trim()||body.role.length>5000||typeof body.name!=='string'||!body.name.trim()||body.name.length>50||!Array.isArray(body.skills)||body.skills.some(s=>typeof s!=='string'||s.length>100))throw Error('请填写有效名称、职责和技能');
        Object.assign(a,{name:body.name.trim(),role:body.role.trim(),skills:body.skills,shareKnowledge:body.shareKnowledge===true});
        await fs.writeFile(path.join(root,'agents.json'),JSON.stringify(lab.agents,null,2));return send(200,{ok:true});
      }
      if(req.url==='/api/files'){
        lab.agent(body.agent);if(!['knowledge','skills'].includes(body.kind)||!/^\p{L}[\p{L}\p{N}_ -]{0,70}\.md$/u.test(body.name)||typeof body.content!=='string'||!body.content.trim()||body.content.length>50000)throw Error('文件名须以文字开头，使用 .md 后缀；内容最多 50000 字符');
        const p=path.join(lab.dir(body.agent,body.kind),body.name);
        await fs.writeFile(p,body.content,{flag:'wx'});return send(200,{ok:true});
      }
      if(req.url==='/api/approve'){await lab.approve(body.id,body.evidence);return send(200,{ok:true});}
      if(!['/api/discuss','/api/teach'].includes(req.url))return send(404,{error:'接口不存在'});
      if(typeof body.topic!=='string'||!body.topic.trim()||body.topic.length>4000)throw Error('课题须为 1–4000 字符');
      if(!modelStatus().configured)return send(400,{error:'请先在项目 .env 配置所选模型服务与 API 密钥，再重启服务'});
      if(req.url==='/api/teach'){lab.agent(body.teacher);lab.agent(body.student);if(body.teacher===body.student)throw Error('教师和学生必须不同');}
      busy=true;const job={id:crypto.randomUUID(),topic:body.topic,status:'running',kind:req.url.endsWith('teach')?'teach':'discuss'};jobs.unshift(job);jobs.splice(30);
      send(202,{ok:true,job});
      (async()=>{try{const result=job.kind==='teach'?await lab.teach(body.teacher,body.student,body.topic):await lab.discuss(body.topic);job.resultId=result.id;job.status='done';}catch(e){job.status='failed';job.error=e.message;}finally{busy=false;}})();return;
    }
    if(req.method!=='GET')return send(405,{error:'请求方法不支持'});
    const assets={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
    const asset=assets[req.url];if(!asset)return send(404,{error:'页面不存在'});
    res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});res.end(await fs.readFile(path.join(root,'web',asset[0])));
  }catch(e){send(400,{error:e.code==='EEXIST'?'同名文件已存在，请换一个名称':e.message});}
});
server.listen(4317,'127.0.0.1',()=>console.log('Agent 工作台：http://127.0.0.1:4317'));
