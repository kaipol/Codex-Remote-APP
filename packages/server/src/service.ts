import type { AppOption, FileSearchResult, RuntimeConfig, Session, SessionDetail, SessionStatus, SkillOption, UserInput } from '@remote/shared';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { cleanConversationText, CodexSessionCatalog, parseUserContent } from './codex-sessions.js';
import { CodexManager } from './codex/manager.js';
import { text, type CodexThread } from './codex/protocol.js';

export class SessionService {
  readonly catalog: CodexSessionCatalog;
  readonly manager: CodexManager;
  private codexHome:string;
  constructor(private store: Store, config: Config, manager?: CodexManager) {
    this.catalog = new CodexSessionCatalog(config.codexSessionsDir);this.codexHome=config.codexHome;
    this.manager = manager ?? new CodexManager(config, store);
  }
  async list(): Promise<Session[]> {
    const rollouts = await this.catalog.refresh();
    let active: Session[] = [];
    try { active = [...(await this.manager.list(false)).map(thread => this.fromThread(thread)),...(await this.manager.list(true)).map(thread => ({...this.fromThread(thread),status:'archived' as const}))]; } catch { /* durable rollout fallback */ }
    const merged = new Map<string,Session>(rollouts.map(item => [item.session_id, item]));
    for (const item of active) merged.set(item.session_id, { ...merged.get(item.session_id), ...item } as Session);
    const names=await this.indexNames();return this.merge([...merged.values()].map(item=>names.has(item.session_id)?{...item,title:names.get(item.session_id)!}:item));
  }
  async refresh(): Promise<Session[]> { return this.list(); }
  async create(cwd: string,runtime:RuntimeConfig={}): Promise<Session> { return this.applyOverlay(this.fromThread(await this.manager.start(cwd,runtime))); }
  async detail(id: string): Promise<SessionDetail | undefined> {
    try {
      const thread = await this.manager.read(id);
      this.store.ensureSession(thread);
      const session = this.applyOverlay(this.fromThread(thread));
      const messages = (thread.turns ?? []).flatMap((turn,turnIndex) => (turn.items ?? []).map((item,itemIndex) => {if(item.type!=='userMessage'&&item.type!=='agentMessage')return null;const role=(item.type==='userMessage'?'user':'assistant') as 'user'|'assistant';const parsed=role==='user'?parseUserContent(text(item.content)):{content:String(item.text??''),references:[]};return {msg_id:item.id,turn_id:turn.id,session_id:id,role,content:cleanConversationText(parsed.content,role),...(parsed.references.length?{references:parsed.references}:{}),timestamp:session.updated_at,seq:turnIndex*1000+itemIndex+1}}).filter((m):m is NonNullable<typeof m>=>m!==null).filter(message=>(message.content.trim()||message.references?.length)&&!isContextSummary(message.content)));
      const historyEvents=(thread.turns??[]).flatMap((turn,turnIndex)=>(turn.items??[]).flatMap((item,itemIndex)=>eventFromItem(id,turn.id,item,session.updated_at,turnIndex*1000+itemIndex+1)));
      return {...session,messages,events:mergeEvents(historyEvents,this.store.eventsAfter(0).filter(e=>e.session===id))};
    } catch {
      const detail = await this.catalog.detail(id);
      return detail ? { ...this.applyOverlay(detail), messages: detail.messages, events: mergeEvents(detail.events,this.store.eventsAfter(0).filter(e=>e.session===id)) } : undefined;
    }
  }
  async update(id: string, changes: { title?: string; status?: SessionStatus; pinned?: boolean }): Promise<Session | undefined> { const detail=await this.detail(id);if(!detail)return undefined;if(changes.title)await this.manager.rename(id,changes.title).catch(()=>{});if(changes.status==='archived'||detail.status==='archived'&&changes.status==='active')await this.manager.archive(id,changes.status==='archived');this.store.updateOverlay(id,changes);return this.applyOverlay(detail) }
  async removeOverlay(id: string): Promise<boolean> { if(!await this.detail(id))return false;this.store.deleteOverlay(id);return true }
  async message(id:string,input:UserInput[],runtime:RuntimeConfig={},clientId?:string){
    if(clientId){const old=this.store.getIdempotent(id,clientId);if(old?.status==='done')return old.response;if(old||!this.store.beginIdempotent(id,clientId))throw Object.assign(new Error('client_id request is already in progress'),{status:409})}
    try { const result=await this.manager.startTurn(id,input,runtime,clientId);if(clientId)this.store.finishIdempotent(id,clientId,result);return result } catch(error){if(clientId)this.store.failIdempotent(id,clientId);throw error}
  }
  async cancel(id:string){return this.manager.interrupt(id)}
  models(){return this.manager.models()}
  skills(cwd:string):Promise<SkillOption[]>{return this.manager.skills(cwd)}
  apps(threadId?:string):Promise<AppOption[]>{return this.manager.apps(threadId)}
  defaults(){return this.manager.defaults()}
  fileSearch(query:string,roots:string[]):Promise<FileSearchResult[]>{return this.manager.fileSearch(query,roots)}
  readDirectory(path:string){return this.manager.readDirectory(path)}
  approvals(sessionId?:string){return this.store.listApprovals(sessionId).map(publicApproval)}
  approval(id:string){const approval=this.store.getApproval(id);return approval?publicApproval(approval):undefined}
  decide(id:string,decision:'accept'|'decline'|'cancel',answers?:Record<string,string[]>){return this.manager.decide(id,decision,answers)}
  private fromThread(t:CodexThread):Session {this.store.ensureSession(t);return {session_id:t.id,title:t.name||t.preview||`Codex ${t.id}`,status:'active',pinned:false,cwd:t.cwd,created_at:new Date(t.createdAt*1000).toISOString(),updated_at:new Date(t.updatedAt*1000).toISOString(),...(t.path?{rollout_path:t.path}:{})}}
  private merge(items: Session[]): Session[] { return items.map(item => this.applyOverlay(item)).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updated_at.localeCompare(a.updated_at)||a.session_id.localeCompare(b.session_id)) }
  private applyOverlay<T extends Session>(session: T): T { const overlay=this.store.getOverlay(session.session_id);return {...session,title:overlay?.title||session.title,status:overlay?.status||session.status,pinned:Boolean(overlay?.pinned)} }
  private async indexNames(){const names=new Map<string,string>();try{for(const line of (await readFile(join(this.codexHome,'session_index.jsonl'),'utf8')).split(/\r?\n/)){if(!line.trim())continue;try{const item=JSON.parse(line);if(typeof item.id==='string'&&typeof item.thread_name==='string'&&item.thread_name.trim())names.set(item.id,item.thread_name.trim())}catch{/* isolate malformed rows */}}}catch{/* optional index */}return names}
}
function publicApproval(approval:any){const {raw_id,epoch,decision,...result}=approval;return result}
function eventFromItem(session:string,turn:string,item:any,timestamp:string,seq:number):any[]{const metadata={turn_id:turn,item_id:item.id,item_type:item.type,status:item.status};if(item.type==='commandExecution')return [{id:`history:${item.id}`,type:'command_execution',session,timestamp,seq,content:item.aggregatedOutput||'',metadata:{...metadata,command:item.command,cwd:item.cwd,exit_code:item.exitCode}}];if(item.type==='fileChange')return [{id:`history:${item.id}`,type:'file_change',session,timestamp,seq,metadata:{...metadata,changes:item.changes}}];if(item.type==='reasoning'||item.type==='plan'){const content=text(item.summary??item.text??item.content);return content.trim()?[{id:`history:${item.id}`,type:'reasoning_status',session,timestamp,seq,content,metadata}]:[]}if(item.type==='contextCompaction')return [{id:`history:${item.id}`,type:'context_compaction',session,timestamp,seq,metadata}];if(item.type==='mcpToolCall'||item.type==='collabAgentToolCall')return [{id:`history:${item.id}`,type:'tool_call',session,timestamp,seq,content:text(item.result??item.error),metadata:{...metadata,server:item.server,tool:item.tool,arguments:item.arguments}}];if(item.type==='webSearch')return [{id:`history:${item.id}`,type:'web_search',session,timestamp,seq,content:String(item.query??''),metadata}];return []}
function mergeEvents(a:any[],b:any[]){const map=new Map<string,any>();for(const event of a)map.set(`${event.type}:${event.metadata?.item_id??event.id}:${event.metadata?.phase??''}`,event);for(const event of b){const key=`${event.type}:${event.metadata?.item_id??event.id}:${event.metadata?.phase??''}`;const existing=map.get(key);if(existing)map.set(key,{...event,seq:existing.seq,timestamp:existing.timestamp});else map.set(key,event)}return [...map.values()]}
function isContextSummary(textValue:string){return /^\s*#{1,3}\s*(?:Handoff Summary|Context (?:Summary|Compaction))\b/i.test(textValue)||/Another language model started to solve this problem/i.test(textValue)}
