import type { AppOption,ApprovalDecision,ApprovalResolution,AuthTokens,CodexDefaults,FileSearchResult,ModelOption,PendingApproval,RuntimeConfig,Session,SessionDetail,SessionStatus,SkillOption,SyncResponse,TurnAccepted,UserInput,WsEnvelope } from '@remote/shared';
const base=import.meta.env.VITE_API_URL||'';
let auth:AuthTokens|null=safeStoredAuth();
function safeStoredAuth(){try{return JSON.parse(localStorage.getItem('auth')||'null') as AuthTokens|null}catch{return null}}
export const hasAuth=()=>!!auth;
export const clearAuth=()=>{auth=null;localStorage.removeItem('auth')};
async function refresh(){if(!auth)throw new Error('未配对');const r=await fetch(base+'/api/auth/refresh',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({device_id:auth.device_id,refresh_token:auth.refresh_token})});if(!r.ok){clearAuth();throw new Error('登录已过期')}auth=await r.json();localStorage.setItem('auth',JSON.stringify(auth));}
async function call<T>(path:string,init:RequestInit={},retry=true):Promise<T>{const r=await fetch(base+path,{...init,headers:{'content-type':'application/json',...(auth?{authorization:`Bearer ${auth.access_token}`}:{}) as Record<string,string>,...init.headers}});if(r.status===401&&retry&&auth){await refresh();return call(path,init,false)}if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||`HTTP ${r.status}`);return r.status===204?undefined as T:r.json()}
export async function pair(code:string){auth=await call<AuthTokens>('/api/pair/request',{method:'POST',body:JSON.stringify({code,device_name:navigator.userAgent.slice(0,60)})});localStorage.setItem('auth',JSON.stringify(auth));return auth}
export const api={
  sessions:()=>call<Session[]>('/api/sessions'),
  refreshSessions:()=>call<Session[]>('/api/sessions/refresh',{method:'POST'}),
  session:(id:string)=>call<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  create:(cwd:string,runtime?:RuntimeConfig)=>call<Session>('/api/sessions',{method:'POST',body:JSON.stringify({cwd,runtime})}),
  update:(id:string,changes:{title?:string;status?:SessionStatus;pinned?:boolean})=>call<Session>(`/api/sessions/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify(changes)}),
  removeOverlay:(id:string)=>call<void>(`/api/sessions/${encodeURIComponent(id)}`,{method:'DELETE'}),
  send:(id:string,input:UserInput[],client_id:string,runtime?:RuntimeConfig)=>call<TurnAccepted>(`/api/sessions/${encodeURIComponent(id)}/messages`,{method:'POST',body:JSON.stringify({role:'user',input,client_id,runtime})}),
  cancel:(id:string)=>call<TurnAccepted>(`/api/sessions/${encodeURIComponent(id)}/cancel`,{method:'POST',body:'{}'}),
  sync:(cursor:number)=>call<SyncResponse>(`/api/sync?cursor=${cursor}`),
  approvals:(sessionId:string)=>call<PendingApproval[]>(`/api/approvals?session_id=${encodeURIComponent(sessionId)}`),
  decide:(requestId:string,decision:ApprovalDecision,answers?:Record<string,string[]>)=>call<ApprovalResolution>(`/api/approvals/${encodeURIComponent(requestId)}/decision`,{method:'POST',body:JSON.stringify({decision,...(answers?{answers}:{})})}),
  models:()=>call<ModelOption[]>('/api/capabilities/models'),
  skills:(cwd:string)=>call<SkillOption[]>(`/api/capabilities/skills?cwd=${encodeURIComponent(cwd)}`),
  apps:(threadId?:string)=>call<AppOption[]>(`/api/capabilities/apps${threadId?`?thread_id=${encodeURIComponent(threadId)}`:''}`),
  defaults:()=>call<CodexDefaults>('/api/capabilities/defaults'),
  cwdRoots:()=>call<string[]>('/api/capabilities/cwd-roots')
  ,fileSearch:(query:string,roots:string)=>call<FileSearchResult[]>(`/api/files/search?query=${encodeURIComponent(query)}&roots=${encodeURIComponent(roots)}`),
  readDirectory:(path:string)=>call<{fileName:string;isDirectory:boolean;isFile:boolean}[]>(`/api/files/list?path=${encodeURIComponent(path)}`)
};
export function connect(onMessage:(m:WsEnvelope)=>void){if(!auth)return null;const origin=base?new URL(base,location.href).origin:location.origin;const u=new URL('/ws',origin);u.protocol=u.protocol==='https:'?'wss:':'ws:';u.searchParams.set('token',auth.access_token);const ws=new WebSocket(u);ws.onmessage=e=>{try{onMessage(JSON.parse(e.data))}catch{/* ignore malformed frames */}};return ws}
