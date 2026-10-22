import https from 'node:https';
// 使用 Node 原生 HTTPS agent，沿用 configureNetwork 设置的代理；总体超时由调用方 signal 控制。
// 不跳转、不重试，不受 fetch 默认的短连接建立超时限制。
export function apiRequest(url,{method,headers,body,signal}){
 return new Promise((resolve,reject)=>{
  const req=https.request(url,{method,headers,signal,timeout:180000},res=>{
   const chunks=[];let size=0;
   res.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){res.destroy(Error('API 响应过大'));return;}chunks.push(chunk);});
   res.on('error',reject);res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');resolve({ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode,json:async()=>JSON.parse(text)});});
  });
  req.on('error',reject);req.end(body);
 });
}
