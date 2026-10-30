import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentInvoker} from './agent-adapters.mjs';

test('configured team sends normalized request and bearer token, then normalizes response',async()=>{
 let request;const invoke=createAgentInvoker({agents:{profile:{url:'https://agent.test/invoke',apiKeyEnv:'CUSTOMER_KEY'}},env:{CUSTOMER_KEY:'secret'},modelInvoke:async()=>{throw Error('unexpected fallback');},fetchImpl:async(url,options)=>{request={url,options};return new Response(JSON.stringify({output:'{"answer":"ok"}',usage:{total_tokens:4},request_id:'req-1'}),{status:200});}});
 const result=await invoke({team:'profile',callId:'call-1',instructions:'do work',input:'{}',jsonMode:true,maxOutputTokens:200},new AbortController().signal);
 assert.equal(request.url,'https://agent.test/invoke');assert.equal(request.options.headers.Authorization,'Bearer secret');assert.equal(JSON.parse(request.options.body).protocol,'agent-collaboration.v1');assert.equal(JSON.parse(request.options.body).agent_id,'customer');assert.equal(JSON.parse(request.options.body).subagent_id,'profile');assert.equal(result.text,'{"answer":"ok"}');assert.equal(result.provider,'external-agent');assert.equal(result.usage.total_tokens,4);
});

test('unconfigured teams use the existing model provider',async()=>{
 const invoke=createAgentInvoker({agents:{},modelInvoke:async(args)=>({text:args.input,provider:'model'})});
 assert.deepEqual(await invoke({team:'risk',input:'raw'},undefined),{text:'raw',provider:'model'});
});

test('external agent must return text output',async()=>{
 const invoke=createAgentInvoker({agents:{risk:{url:'https://agent.test/invoke'}},modelInvoke:async()=>{},fetchImpl:async()=>new Response('{}',{status:200})});
 await assert.rejects(invoke({team:'risk'},undefined),/须包含 output、text 或 result/);
});
