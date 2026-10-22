import test from 'node:test';
import assert from 'node:assert/strict';
import {modelConfig,callModel,callModelDetailed,reloadModelEnvironment} from './model-provider.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const env={LLM_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'fake-test-key'};
test('通用协作启用官方 JSON 模式，截断失败仍保留计费用量',async()=>{
 await assert.rejects(callModelDetailed({instructions:'返回 JSON',input:'问题',jsonMode:true},{env,fetchImpl:async(url,opts)=>{assert.deepEqual(JSON.parse(opts.body).response_format,{type:'json_object'});return {ok:true,json:async()=>({usage:{total_tokens:123},choices:[{finish_reason:'length',message:{content:'{'}}]})};}}),error=>{assert.equal(error.metadata.usage.total_tokens,123);return /未完整完成/.test(error.message);});
});
test('API 证据保留实际 HTTP 状态、响应 ID、模型及用量，不暴露密钥',async()=>{
 const result=await callModelDetailed({instructions:'JSON',input:'check',jsonMode:true},{env,fetchImpl:async()=>({ok:true,status:200,json:async()=>({id:'provider-response-123',model:'returned-model',usage:{total_tokens:7},choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]})})});
 assert.equal(result.httpStatus,200);assert.equal(result.responseId,'provider-response-123');assert.equal(result.model,'returned-model');assert.equal(result.usage.total_tokens,7);assert.equal(result.endpoint,'https://api.deepseek.com/chat/completions');assert.ok(Number.isFinite(Date.parse(result.receivedAt)));assert.doesNotMatch(JSON.stringify(result),/fake-test-key|Authorization/);
});
test('DeepSeek 使用 Chat Completions、非思考模式和正文输出，不泄露推理内容',async()=>{
  let called=0;
  const output=await callModel({instructions:'职责',input:'问题'},{env,fetchImpl:async(url,opts)=>{
    called++;assert.equal(url,'https://api.deepseek.com/chat/completions');
    const body=JSON.parse(opts.body);assert.equal(body.model,'deepseek-flash');assert.deepEqual(body.thinking,{type:'disabled'});assert.equal(body.max_tokens,3000);assert.equal(opts.redirect,'error');
    assert.deepEqual(body.messages,[{role:'system',content:'职责'},{role:'user',content:'问题'}]);
    return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'最终正文',reasoning_content:'内部内容'}}]})};
  }});assert.equal(output,'最终正文');assert.equal(called,1);
});
test('保留原有 Responses 后端',async()=>{
  const result=await callModel({instructions:'角色',input:'问题'},{env:{OPENAI_API_KEY:'test',OPENAI_MODEL:'test-model'},fetchImpl:async(url,opts)=>{assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(JSON.parse(opts.body).store,false);return {ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:'回复'}]}]})};}});assert.equal(result,'回复');
});
test('缺失密钥、截断和 HTTP 失败不向下游返回不完整内容，也不重试',async()=>{
  await assert.rejects(callModel({input:'问题'},{env:{LLM_PROVIDER:'deepseek'},fetchImpl:()=>{throw Error('不得联网');}}),/DEEPSEEK_API_KEY/);
  let calls=0;await assert.rejects(callModel({input:'问题'},{env,fetchImpl:async()=>{calls++;return {ok:false,status:401};}}),/HTTP 401/);assert.equal(calls,1);
  await assert.rejects(callModel({input:'问题'},{env,fetchImpl:async()=>({ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'半个答案'}}]})})}),/未完整完成/);
});
test('拒绝不安全地址和未知后端',()=>{
  for(const base of ['http://api.deepseek.com','https://secret@example.com','https://api.deepseek.com?key=x'])assert.throws(()=>modelConfig({...env,DEEPSEEK_BASE_URL:base}));
  assert.throws(()=>modelConfig({LLM_PROVIDER:'unknown'}));
});
test('重新读取本地配置只返回非密钥字段',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'provider-test-'));
  try{
    await fs.writeFile(path.join(root,'.env'),'LLM_PROVIDER=deepseek\nDEEPSEEK_API_KEY=fake-private-sentinel\n');
    const status=await reloadModelEnvironment(root);assert.equal(status.configured,true);assert.deepEqual(Object.keys(status).sort(),['configured','model','provider']);assert.doesNotMatch(JSON.stringify(status),/sentinel/);
    await fs.writeFile(path.join(root,'.env'),'LLM_PROVIDER=deepseek\nDEEPSEEK_API_KEY=\n');assert.equal((await reloadModelEnvironment(root)).configured,false);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
