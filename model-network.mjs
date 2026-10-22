import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
let status={mode:'auto',route:'direct',source:'default',tlsVerified:true};
export function resolveNetwork(env,system={enabled:false}){
  const mode=env.LLM_NETWORK_MODE||'auto';
  if(!['auto','direct','proxy'].includes(mode))throw Error('LLM_NETWORK_MODE 须为 auto、direct 或 proxy');
  let proxy='',source='direct / VPN TUN';
  if(mode!=='direct'){
    proxy=env.LLM_PROXY_URL||env.https_proxy||env.HTTPS_PROXY||env.http_proxy||env.HTTP_PROXY||env.ALL_PROXY||'';
    if(proxy)source='environment';
    else if(system.enabled&&system.server){const match=system.server.match(/(?:^|;)https=([^;]+)/);proxy=match?match[1]:system.server.split(';')[0].replace(/^http=/,'');if(!/^\w+:\/\//.test(proxy))proxy='http://'+proxy;source='Windows system proxy';}
  }
  if(mode==='proxy'&&!proxy)throw Error('代理模式缺少 LLM_PROXY_URL 或系统代理');
  if(proxy){let url;try{url=new URL(proxy);}catch{throw Error('代理地址格式无效');}if(!['http:','https:'].includes(url.protocol)||url.pathname!=='/'||url.search||url.hash)throw Error('仅支持 HTTP(S) 代理地址；SOCKS 或 PAC 请使用 VPN 的 HTTP 代理入口');}
  const bypass=['localhost','127.0.0.1','::1',env.no_proxy||env.NO_PROXY||''].filter(Boolean).join(',');
  return {mode,proxy,source,proxyEnv:{HTTPS_PROXY:proxy,HTTP_PROXY:proxy,NO_PROXY:bypass}};
}
async function windowsProxy(){
  if(process.platform!=='win32')return {enabled:false};
  const key='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  try{const [enabled,server]=await Promise.all(['ProxyEnable','ProxyServer'].map(value=>exec('reg.exe',['query',key,'/v',value],{windowsHide:true,timeout:3000})));return {enabled:/ProxyEnable\s+REG_DWORD\s+0x1\b/.test(enabled.stdout),server:server.stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/)?.[1]?.trim()||''};}catch{return {enabled:false};}
}
export async function configureNetwork(env){
  const resolved=resolveNetwork(env,await windowsProxy());
  if(resolved.proxy&&typeof http.setGlobalProxyFromEnv!=='function')throw Error('代理模式需要 Node.js 24.14+；当前未发送请求，请升级 Node 或使用 VPN TUN 直连');
  if(typeof http.setGlobalProxyFromEnv==='function')http.setGlobalProxyFromEnv(resolved.proxyEnv);
  status={mode:resolved.mode,route:resolved.proxy?'proxy':'direct',source:resolved.source,tlsVerified:true};
  return networkStatus();
}
export function networkStatus(){return {...status};}
