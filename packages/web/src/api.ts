import type { AppOption,ApprovalDecision,ApprovalResolution,AuthTokens,CodexDefaults,FileSearchResult,ModelOption,PendingApproval,ProjectInfo,RuntimeConfig,Session,SessionDetail,SessionStatus,SkillOption,SyncResponse,TurnAccepted,UserInput,WsEnvelope } from '@remote/shared';
import { secureStore, secureRetrieve, secureClear } from './composables/secureStorage';
function apiBase(){
  if(runtimeBase)return runtimeBase;
  const configured=import.meta.env.VITE_API_URL?.trim();
  if(configured)return configured.replace(/\/+$/,'');
  // Avoid depending on Vite's HMR proxy for API traffic during local development.
  if(location.port==='5173'){
    const backend=new URL(location.href);
    backend.port='8787';backend.pathname='';backend.search='';backend.hash='';
    return backend.origin;
  }
  return '';
}
let runtimeBase=readStoredServerUrl();
let auth:AuthTokens|null=null;
let authReady:Promise<void>|null=null;
let refreshInFlight:Promise<void>|null=null;

export class ApiError extends Error {
  constructor(readonly status:number,message:string) {
    super(message);
    this.name='ApiError';
  }
}

function readStoredServerUrl(){try{return localStorage.getItem('server-url')?.trim().replace(/\/+$/,'')||''}catch{return ''}}
export function currentServerUrl(){
  const configured=apiBase();
  if(configured)return configured;
  const origin=location.protocol==='http:'||location.protocol==='https:'?location.origin:'';
  // Capacitor's bundled WebView uses http://localhost without a port. That
  // is the client origin, not the remote Codex server, so leave the field
  // empty and require an explicit LAN/VPS address.
  if(origin&&location.hostname==='localhost'&&!location.port)return '';
  return origin;
}
export function configureServerUrl(value:string){
  let url:URL;
  try{url=new URL(value.trim())}catch{throw new Error('请输入有效的服务器地址')}
  if(url.protocol!=='http:'&&url.protocol!=='https:')throw new Error('服务器地址必须使用 http:// 或 https://');
  runtimeBase=url.origin;
  localStorage.setItem('server-url',runtimeBase);
  return runtimeBase;
}

// Load auth from secure storage on startup
function initAuth():Promise<void>{
  if(authReady)return authReady;
  authReady=(async()=>{
    // Try secure storage first
    auth=await secureRetrieve();
    // Fall back to localStorage for migration from older versions
    if(!auth){
      try{
        const legacy=JSON.parse(localStorage.getItem('auth')||'null') as AuthTokens|null;
        if(legacy){
          auth=legacy;
          await secureStore(legacy);
          localStorage.removeItem('auth');
        }
      }catch{/* ignore */}
    }
  })();
  return authReady;
}

export const hasAuth=()=>!!auth;
// Callbacks notified when auth is cleared, so UI can return to pairing screen
const authLostCallbacks:Array<()=>void>=[];
const tokenRefreshedCallbacks:Array<()=>void>=[];
export function onAuthLost(cb:()=>void){authLostCallbacks.push(cb)}
export function onTokenRefreshed(cb:()=>void){tokenRefreshedCallbacks.push(cb)}
function notifyAuthLost(){for(const cb of authLostCallbacks)try{cb()}catch{/* isolate */}}
function notifyTokenRefreshed(){for(const cb of tokenRefreshedCallbacks)try{cb()}catch{/* isolate */}}

export const clearAuth=async(notify=true)=>{auth=null;await secureClear();localStorage.removeItem('auth');if(notify)notifyAuthLost()};

async function refresh(){
  if(refreshInFlight)return refreshInFlight;
  refreshInFlight=(async()=>{
    if(!auth)throw new Error('未配对');
    let r:Response;
    try{
      r=await fetch(apiBase()+'/api/auth/refresh',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({device_id:auth.device_id,refresh_token:auth.refresh_token})});
    }catch(error){
      console.warn('[remote:auth] token refresh unavailable',error);
      throw new Error('服务暂时不可用，请稍后重试');
    }
    if(r.status===401||r.status===403){await clearAuth();throw new Error('登录已过期')}
    if(!r.ok){
      const detail=(await r.json().catch(()=>({}))) as {error?:string};
      console.warn('[remote:auth] token refresh failed',{status:r.status,error:detail.error});
      throw new Error(detail.error||`服务暂时不可用 (HTTP ${r.status})`);
    }
    const refreshed=await r.json() as AuthTokens;auth=refreshed;await secureStore(refreshed);notifyTokenRefreshed();
  })().finally(()=>{refreshInFlight=null});
  return refreshInFlight;
}

async function call<T>(path:string,init:RequestInit={},retry=true):Promise<T>{
  await initAuth();
  let r:Response;
  try{r=await fetch(apiBase()+path,{...init,headers:{'content-type':'application/json',...(auth?{authorization:`Bearer ${auth.access_token}`}:{}) as Record<string,string>,...init.headers}})}
  catch(error){console.warn('[remote:http] request unavailable',{path,error});throw new Error('服务暂时不可用，请检查后端连接')}
  if(r.status===401&&retry&&auth){await refresh();return call(path,init,false)}
  if(!r.ok)throw new ApiError(r.status,(await r.json().catch(()=>({}))).error||`HTTP ${r.status}`);
  return r.status===204?undefined as T:r.json();
}

export async function pair(code:string){
  await initAuth();
  console.info('[remote:pair] requesting pairing');
  const result=await call<AuthTokens>('/api/pair/request',{method:'POST',body:JSON.stringify({code,device_name:navigator.userAgent.slice(0,60)})});
  auth=result;
  await secureStore(auth);
  console.info('[remote:pair] pairing accepted');
  return auth;
}

export async function ensureAuth():Promise<void>{await initAuth()}

// Force-refresh the token (used before WebSocket reconnect to avoid 401 on upgrade)
export async function ensureFreshToken():Promise<boolean>{
  await initAuth();
  if(!auth)return false;
  try{await refresh();return true}catch{return false}
}

export const api={
  sessions:()=>call<Session[]>('/api/sessions'),
	  refreshSessions:()=>call<Session[]>('/api/sessions/refresh',{method:'POST'}),
	  revoke:()=>call<void>('/api/auth/device',{method:'DELETE'}),
  session:(id:string)=>call<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  create:(cwd:string,runtime?:RuntimeConfig)=>call<Session>('/api/sessions',{method:'POST',body:JSON.stringify({cwd,runtime})}),
  update:(id:string,changes:{title?:string;status?:SessionStatus;pinned?:boolean})=>call<Session>(`/api/sessions/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify(changes)}),
  removeOverlay:(id:string)=>call<void>(`/api/sessions/${encodeURIComponent(id)}`,{method:'DELETE'}),
  send:(id:string,input:UserInput[],client_id:string,runtime?:RuntimeConfig)=>call<TurnAccepted>(`/api/sessions/${encodeURIComponent(id)}/messages`,{method:'POST',body:JSON.stringify({role:'user',input,client_id,runtime})}),
  cancel:(id:string)=>call<TurnAccepted>(`/api/sessions/${encodeURIComponent(id)}/cancel`,{method:'POST',body:'{}'}),
  sync:(cursor:number,streamId='')=>call<SyncResponse>(`/api/sync?cursor=${cursor}${streamId?`&stream_id=${encodeURIComponent(streamId)}`:''}`),
  approvals:(sessionId:string)=>call<PendingApproval[]>(`/api/approvals?session_id=${encodeURIComponent(sessionId)}`),
  decide:(requestId:string,decision:ApprovalDecision,answers?:Record<string,string[]>)=>call<ApprovalResolution>(`/api/approvals/${encodeURIComponent(requestId)}/decision`,{method:'POST',body:JSON.stringify({decision,...(answers?{answers}:{})})}),
  models:()=>call<ModelOption[]>('/api/capabilities/models',{cache:'no-store'}),
  skills:(cwd:string)=>call<SkillOption[]>(`/api/capabilities/skills?cwd=${encodeURIComponent(cwd)}`,{cache:'no-store'}),
  apps:(threadId?:string)=>call<AppOption[]>(`/api/capabilities/apps${threadId?`?thread_id=${encodeURIComponent(threadId)}`:''}`,{cache:'no-store'}),
  defaults:()=>call<CodexDefaults>('/api/capabilities/defaults',{cache:'no-store'}),
  cwdRoots:()=>call<string[]>('/api/capabilities/cwd-roots'),
  projects:()=>call<{projects:ProjectInfo[];sidebarOrder:Record<string,string[]>;projectOrder:string[]}>('/api/projects')
  ,fileSearch:(query:string,roots:string)=>call<FileSearchResult[]>(`/api/files/search?query=${encodeURIComponent(query)}&roots=${encodeURIComponent(roots)}`),
  readDirectory:(path:string)=>call<{fileName:string;isDirectory:boolean;isFile:boolean}[]>(`/api/files/list?path=${encodeURIComponent(path)}`),
  openPath:(path:string)=>call<void>('/api/files/open',{method:'POST',body:JSON.stringify({path})})
};

export function connect(onMessage:(m:WsEnvelope)=>void){
  if(!auth)return null;
  const base=apiBase();
  const origin=base?new URL(base,location.href).origin:location.origin;
  const u=new URL('/ws',origin);
  u.protocol=u.protocol==='https:'?'wss:':'ws:';
  u.searchParams.set('token',auth.access_token);
  const ws=new WebSocket(u);
  ws.onmessage=e=>{try{const message=JSON.parse(e.data) as WsEnvelope;console.debug('[remote:ws] message',message.type);onMessage(message)}catch(error){console.warn('[remote:ws] malformed frame',error)}};
  // Suppress unhandled error events so they don't crash the app; onclose handles reconnection
  ws.onerror=()=>{};
  return ws;
}
