import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { AppServerProcess } from './app-server-process.js';
import { JsonRpcClient,RpcRemoteError,RpcUnavailableError } from './json-rpc-client.js';
import { METHODS,APPROVAL_KINDS,ApprovalNotSupportedError,approvalResult,type ApprovalDecision,type CodexThread,type ThreadListResponse,type ThreadResponse,type TurnResponse,record } from './protocol.js';
import { routeNotification } from './notification-router.js';
import type { AppOption,CapabilityKind,CodexDefaults,FileSearchResult,ModelOption,ReasoningEffort,RuntimeConfig,SkillOption,UserInput } from '@remote/shared';
import { discoverApps,discoverProviderModels,discoverSkills } from '../local-capabilities.js';

const SILENT_NOTIFICATION_METHODS=new Set([
  'remoteControl/status/changed',
  'mcpServer/startupStatus/updated',
  'app/list/updated',
]);
const ALL_CAPABILITIES:CapabilityKind[]=['models','skills','apps','defaults'];
const CAPABILITY_NOTIFICATIONS=new Map<string,CapabilityKind[]>([
  ['account/updated',['models','apps','defaults']],
  ['account/login/completed',ALL_CAPABILITIES],
  ['authStatusChange',ALL_CAPABILITIES],
  ['loginChatGptComplete',ALL_CAPABILITIES],
  ['app/list/updated',['apps']],
  ['mcpServer/oauthLogin/completed',['apps']],
]);

export class CodexManager extends EventEmitter {
 readonly rpc:JsonRpcClient;private initialized?:Promise<void>;private queues=new Map<string,Promise<unknown>>();private resumed=new Set<string>();private active=new Map<string,string>();private completed=new Map<string,string>();private epoch=Date.now();
 constructor(private config:Config,private store:Store,rpc?:JsonRpcClient){
   super();this.store.expireApprovalsBefore(this.epoch);
   this.rpc=rpc??new JsonRpcClient(new AppServerProcess(config.codexCommand,config.codexArgs,config.appServerCwd),config.codexRequestTimeoutMs);
   this.rpc.on('notification',(m:any)=>this.notification(m.method,m.params));
   this.rpc.on('serverRequest',(m:any)=>this.serverRequest(m));
	   this.rpc.on('unavailable',()=>{
	     this.initialized=undefined;this.resumed.clear();this.completed.clear();this.epoch+=1;this.store.expireApprovalsBefore(this.epoch);
	     this.store.markPendingIdempotencyUncertain();
	     this.emit('capabilities',ALL_CAPABILITIES);
     for(const [sessionId,turnId] of this.active){
       const ev=this.store.addEvent({id:'failed:'+sessionId+':'+turnId+':'+Date.now(),type:'turn_failed',session:sessionId,timestamp:new Date().toISOString(),metadata:{turn_id:turnId,status:'unavailable',error:'Codex app-server restarted'}});
       this.emit('event',ev);
     }
     this.active.clear();
   });
   this.rpc.on('malformed',(line:string)=>this.emit('debug',{kind:'malformed_json',line}));
 }
 private async ready(){if(!this.initialized)this.initialized=(async()=>{await this.rpc.request(METHODS.initialize,{clientInfo:{name:'codex-remote',title:'Codex Remote',version:'0.1.0'},capabilities:null});this.rpc.notify(METHODS.initialized,{})})().catch(e=>{this.initialized=undefined;throw e});return this.initialized}
 async list(archived=false):Promise<CodexThread[]>{await this.ready();let cursor:string|null=null;const all:CodexThread[]=[];do{const r:ThreadListResponse=await this.rpc.request<ThreadListResponse>(METHODS.threadList,{cursor,limit:100,sortKey:'updated_at',archived});all.push(...(r.data??[]));cursor=r.nextCursor??null}while(cursor);return all}
 async read(id:string,includeTurns=true){await this.ready();const params:any={threadId:id};if(includeTurns)params.includeTurns=true;return (await this.rpc.request<ThreadResponse>(METHODS.threadRead,params)).thread}
 async start(cwd:string,runtime:RuntimeConfig={}){await this.ready();const thread=(await this.rpc.request<ThreadResponse>(METHODS.threadStart,{cwd:resolve(cwd),...threadRuntime(runtime)})).thread;this.resumed.add(thread.id);this.store.ensureSession(thread);return thread}
 async resume(id:string,cwd?:string){await this.ready();if(this.resumed.has(id))return;const params:any={threadId:id};if(cwd)params.cwd=resolve(cwd);const thread=(await this.rpc.request<ThreadResponse>(METHODS.threadResume,params)).thread;this.resumed.add(id);this.store.ensureSession(thread)}
  startTurn(id:string,input:UserInput[]|string,runtime:RuntimeConfig|string={},clientId?:string){const items=typeof input==='string'?[{type:'text' as const,text:input}]:input;const config=typeof runtime==='string'?{}:runtime;const requestId=typeof runtime==='string'?runtime:clientId;return this.serial(id,async()=>{for(let attempt=0;attempt<2;attempt++)try{await this.resume(id);if(this.active.has(id))throw Object.assign(new Error('thread already has an active turn'),{status:409});const result=await this.rpc.request<TurnResponse>(METHODS.turnStart,{threadId:id,clientUserMessageId:requestId,input:items.map(item=>item.type==='text'?{...item,text_elements:[]}:item),...turnRuntime(config)});if(this.completed.get(id)!==result.turn.id)this.active.set(id,result.turn.id);return {thread_id:id,turn_id:result.turn.id,status:'started'}}catch(error){if(attempt===0&&isWriterConflict(error)){await this.restartConnection();continue}throw error}throw new Error('unreachable')})}
 async interrupt(id:string){await this.ready();let turnId=this.active.get(id);if(!turnId){try{const thread=await this.read(id);const turn=[...(thread.turns??[])].reverse().find(item=>isActiveTurn(item.status));if(turn){turnId=turn.id;this.active.set(id,turnId)}}catch{/* app-server unavailable is reported as a normal conflict below */}}if(!turnId)throw Object.assign(new Error('no active turn'),{status:409});await this.rpc.request(METHODS.turnInterrupt,{threadId:id,turnId});return {thread_id:id,turn_id:turnId,status:'interrupt_requested'}}
 async models():Promise<ModelOption[]>{const providerModels=await discoverProviderModels(this.config.codexHome);try{await this.ready();const remote:ModelOption[]=[];const seenModels=new Set<string>(),seenCursors=new Set<string>();let cursor:string|null=null;do{const r:any=await this.rpc.request(METHODS.modelList,{cursor,limit:100,includeHidden:false});for(const raw of Array.isArray(r.data)?r.data:[]){const item=modelOption(raw);if(!item||seenModels.has(item.model))continue;seenModels.add(item.model);remote.push(item)}const next=typeof r.nextCursor==='string'&&r.nextCursor?r.nextCursor:null;if(!next||seenCursors.has(next)){cursor=null}else{seenCursors.add(next);cursor=next}}while(cursor);if(!providerModels)return remote;const remoteByModel=new Map(remote.map(item=>[item.model,item]));return providerModels.map(item=>remoteByModel.get(item.model)??item)}catch{return providerModels??[]}}
 async skills(cwd:string):Promise<SkillOption[]>{const local=await discoverSkills(this.config.codexHome);try{await this.ready();const r:any=await this.rpc.request(METHODS.skillsList,{cwds:[resolve(cwd)]});return mergeBy(local,(r.data??[]).flatMap((x:any)=>x.skills??[]).map((s:any)=>({name:String(s.name),description:String(s.description??s.shortDescription??''),path:String(s.path),scope:s.scope,enabled:s.enabled!==false})),x=>x.path)}catch{return local}}
 async apps(threadId?:string):Promise<AppOption[]>{const local=await discoverApps(this.config.codexHome);try{await this.ready();let cursor:null|string=null;const out:AppOption[]=[];do{const r:any=await this.rpc.request(METHODS.appList,{cursor,limit:100,threadId});out.push(...(r.data??[]).map((a:any)=>({id:String(a.id),name:String(a.name),description:a.description??undefined,logoUrl:a.logoUrl??undefined,isAccessible:Boolean(a.isAccessible),isEnabled:Boolean(a.isEnabled)})));cursor=r.nextCursor??null}while(cursor);return mergeBy(local,out,x=>x.id)}catch{return local}}
 async defaults():Promise<CodexDefaults>{try{await this.ready();const r:any=await this.rpc.request(METHODS.configRead,{includeLayers:false});return defaultsFromRecord(r.config??{})}catch{return this.fileDefaults()}}
 private async fileDefaults():Promise<CodexDefaults>{try{return defaultsFromRecord(parseTopLevelToml(await readFile(join(this.config.codexHome,'config.toml'),'utf8')))}catch{return {}}}
 async archive(id:string,archived:boolean){await this.ready();await this.rpc.request(archived?METHODS.threadArchive:METHODS.threadUnarchive,{threadId:id})}
  async rename(id:string,name:string){await this.ready();await this.rpc.request(METHODS.threadNameSet,{threadId:id,name})}
  private async restartConnection(){
    this.initialized=undefined;
    this.resumed.clear();
    this.completed.clear();
    await this.rpc.close();
    await this.ready();
  }
  private serial<T>(id:string,fn:()=>Promise<T>):Promise<T>{const prior=this.queues.get(id)??Promise.resolve();const next=prior.catch(()=>{}).then(fn);const tracked=next.then(()=>undefined,()=>undefined);this.queues.set(id,tracked);void tracked.then(()=>{if(this.queues.get(id)===tracked)this.queues.delete(id)});return next}
  private notification(method:string,params:unknown){const capabilities=CAPABILITY_NOTIFICATIONS.get(method);if(capabilities)this.emit('capabilities',capabilities);const event=routeNotification(method,params);if(event){this.ensureNotificationSession(event,params);const saved=this.store.addEvent(event);if(saved.type==='turn_started'){const p=record(params);this.active.set(saved.session,String(record(p.turn).id??p.turnId??''))}if(saved.type==='turn_completed'||saved.type==='turn_failed'){const turnId=typeof saved.metadata?.turn_id==='string'?saved.metadata.turn_id:'';if(turnId)this.completed.set(saved.session,turnId);if(!turnId||this.active.get(saved.session)===turnId)this.active.delete(saved.session)};this.emit('event',saved)}else if(!capabilities&&!SILENT_NOTIFICATION_METHODS.has(method)&&!isSilentMessageStart(method,params))this.emit('debug',{kind:'unknown_notification',method})}
  private ensureNotificationSession(event:{type:string;session:string},params:unknown){const thread=record(record(params).thread);if(event.type==='session_updated'&&Object.keys(thread).length){const now=Math.floor(Date.now()/1000),createdAt=typeof thread.createdAt==='number'?thread.createdAt:now,updatedAt=typeof thread.updatedAt==='number'?thread.updatedAt:createdAt;this.store.ensureSession({id:event.session,preview:typeof thread.preview==='string'?thread.preview:undefined,name:typeof thread.name==='string'?thread.name:null,cwd:typeof thread.cwd==='string'?thread.cwd:'',createdAt,updatedAt});return}this.store.ensureEventSession(event.session)}
 private serverRequest(message:any){const p=record(message.params),thread=String(p.threadId??p.conversationId??record(p.thread).id??''),turn=String(p.turnId??''),item=String(p.itemId??p.callId??'');const kind=String(message.method);if(!APPROVAL_KINDS.has(kind))return this.emit('debug',{kind:'unsupported_server_request',method:message.method});if(!thread)return this.emit('debug',{kind:'invalid_server_request',method:message.method});this.store.ensureEventSession(thread);const requestId=`${this.epoch}:${String(message.id)}`;this.store.addApproval({requestId,rawId:message.id,epoch:this.epoch,threadId:thread,turnId:turn,itemId:item,kind,payload:message.params});const saved=this.store.addEvent({id:`approval:${requestId}`,type:'approval_requested',session:thread,timestamp:new Date().toISOString(),metadata:{request_id:requestId,kind,turn_id:turn,item_id:item}});this.emit('event',saved)}
 /**
  * Answers a captured app-server server request. The store transition happens
  * first so a duplicate decision cannot write twice to the same JSON-RPC id,
  * and the pending row is restored when the write fails.
  */
 decide(requestId:string,decision:ApprovalDecision,answers?:Record<string,string[]>){
  const approval=this.store.getApproval(requestId);
  if(!approval)throw Object.assign(new Error('approval request not found'),{status:404});
  if(approval.status!=='pending')throw Object.assign(new Error(`approval request is already ${approval.status}`),{status:409});
  if(approval.epoch!==this.epoch){this.store.expireApprovalsBefore(this.epoch);throw Object.assign(new Error('Codex app-server restarted; this request can no longer be answered'),{status:409})}
  const available=record(approval.payload).availableDecisions;if(Array.isArray(available)&&!available.some(value=>value===decision))throw Object.assign(new Error(`decision ${decision} is not available for this request`),{status:422});
  const result=approvalResult(approval.kind,decision,answers);
  if(!this.store.settleApproval(requestId,decision))throw Object.assign(new Error('approval request is already resolved'),{status:409});
  try{this.rpc.respond(approval.raw_id,result)}catch(error){this.store.revertApproval(requestId);throw error}
  return {request_id:requestId,session_id:approval.session_id,decision,status:'resolved' as const};
 }
 async fileSearch(query:string,roots:string[]):Promise<FileSearchResult[]>{await this.ready();try{const r:any=await this.rpc.request(METHODS.fuzzyFileSearch,{query,roots});return (r.files??[]).map((f:any)=>({path:String(f.path),file_name:String(f.file_name),match_type:f.match_type==='directory'?'directory':'file',score:Number(f.score??0),root:String(f.root??'')}))}catch{return[]}}
 async readDirectory(path:string):Promise<{fileName:string;isDirectory:boolean;isFile:boolean}[]>{await this.ready();try{const r:any=await this.rpc.request(METHODS.fsReadDirectory,{path});return (r.entries??[]).map((e:any)=>({fileName:String(e.fileName),isDirectory:Boolean(e.isDirectory),isFile:Boolean(e.isFile)}))}catch{return[]}}
 async close(){await this.rpc.close()}
  /** Thread IDs that currently have a turn started by this manager and not yet completed/failed. */
  activeTurnThreadIds(): Set<string> { return new Set(this.active.keys()) }
  /** Turn IDs that currently have a turn started by this manager and not yet completed/failed. */
  activeTurnIds(): Set<string> { return new Set(this.active.values()) }
}
export {RpcUnavailableError,ApprovalNotSupportedError};
function threadRuntime(r:RuntimeConfig){return {...(r.model?{model:r.model}:{}),...(r.approvalPolicy?{approvalPolicy:r.approvalPolicy}:{}),...(r.sandbox?{sandbox:r.sandbox}:{}),...(r.effort?{config:{model_reasoning_effort:r.effort}}:{})}}
function turnRuntime(r:RuntimeConfig){return {...(r.model?{model:r.model}:{}),...(r.effort?{effort:r.effort}:{}),...(r.approvalPolicy?{approvalPolicy:r.approvalPolicy}:{}),...(r.sandbox?{sandboxPolicy:sandboxPolicy(r.sandbox)}:{})}}
function sandboxPolicy(mode:RuntimeConfig['sandbox']){if(mode==='danger-full-access')return {type:'dangerFullAccess'};if(mode==='read-only')return {type:'readOnly',networkAccess:true};return {type:'workspaceWrite',writableRoots:[],networkAccess:true,excludeTmpdirEnvVar:false,excludeSlashTmp:false}}
function value(v:unknown){return typeof v==='string'&&v?v:undefined}
function normalizeSandbox(v:unknown):RuntimeConfig['sandbox']|undefined{const s=value(v)?.replace(/_/g,'-');return s==='read-only'||s==='workspace-write'||s==='danger-full-access'?s:undefined}
function normalizeEffort(v:unknown):CodexDefaults['effort']{const value=valueOf(v);return value&&isReasoningEffort(value)?value:undefined}
function normalizeApproval(v:unknown):CodexDefaults['approvalPolicy']{const value=valueOf(v)?.replace(/_/g,'-');return value&&['untrusted','on-failure','on-request','never'].includes(value)?value as CodexDefaults['approvalPolicy']:undefined}
function valueOf(v:unknown){return typeof v==='string'&&v?v:undefined}
function defaultsFromRecord(c:Record<string,unknown>):CodexDefaults{return {model:value(c.model),effort:normalizeEffort(c.model_reasoning_effort),approvalPolicy:normalizeApproval(c.approval_policy),sandbox:normalizeSandbox(c.sandbox_mode)}}
function parseTopLevelToml(source:string):Record<string,unknown>{const result:Record<string,unknown>={};let top=true;for(const raw of source.split(/\r?\n/)){const line=raw.replace(/#.*$/,'').trim();if(!line)continue;if(line.startsWith('[')){top=false;continue}if(!top)continue;const match=line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);if(!match)continue;result[match[1]]=match[2].trim().replace(/^['"]|['"]$/g,'')}return result}
function mergeBy<T>(local:T[],remote:T[],key:(item:T)=>string):T[]{const result=new Map(local.map(item=>[key(item),item]));for(const item of remote)result.set(key(item),item);return [...result.values()]}
function modelOption(value:unknown):ModelOption|undefined{const item=record(value);if(item.hidden===true||String(item.visibility??'').toLowerCase()==='hide')return undefined;const model=stringValue(item.model)||stringValue(item.id);if(!model)return undefined;const supportedReasoningEfforts=Array.isArray(item.supportedReasoningEfforts)?[...new Set(item.supportedReasoningEfforts.map(option=>typeof option==='string'?option:stringValue(record(option).reasoningEffort)||stringValue(record(option).effort)).filter((effort):effort is ReasoningEffort=>typeof effort==='string'&&isReasoningEffort(effort)))]:[];const modalities=Array.isArray(item.inputModalities)?item.inputModalities.map(String):['text'];return {id:stringValue(item.id)||model,model,displayName:stringValue(item.displayName)||stringValue(item.display_name)||model,description:stringValue(item.description),isDefault:Boolean(item.isDefault),defaultReasoningEffort:normalizeEffort(item.defaultReasoningEffort??item.default_reasoning_effort),supportedReasoningEfforts,inputModalities:modalities}}
function stringValue(value:unknown){return typeof value==='string'&&value.trim()?value.trim():undefined}
function isReasoningEffort(value:string):value is ReasoningEffort{return ['none','minimal','low','medium','high','xhigh','max','ultra'].includes(value)}
function isSilentMessageStart(method:string,params:unknown){if(method!=='item/started')return false;const kind=String(record(record(params).item).type??'');return kind==='agentMessage'||kind==='userMessage'}
function isActiveTurn(status:unknown){const value=String(status??'').toLowerCase();return value==='inprogress'||value==='active'||value==='started'||value==='running'}
function isWriterConflict(error:unknown){return error instanceof RpcRemoteError&&/already has an active writer|active writer/i.test(error.message)}
