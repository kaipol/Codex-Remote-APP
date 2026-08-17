import type { AppOption, FileSearchResult, RuntimeConfig, Session, SessionDetail, SessionStatus, SkillOption, UserInput } from '@remote/shared';
import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { cleanConversationText, CodexSessionCatalog, parseUserInput } from './codex-sessions.js';
import { CodexManager } from './codex/manager.js';
import { RpcTimeoutError,RpcUnavailableError } from './codex/json-rpc-client.js';
import { text, type CodexThread } from './codex/protocol.js';
import { DesktopStateReader } from './desktop-state.js';

export class SessionService {
  readonly catalog: CodexSessionCatalog;
  readonly manager: CodexManager;
  private codexHome:string;
  private cwdAllowlist:string[];
  private cwdRoots?:Promise<string[]>;
  private skillRoots?:Promise<string[]>;
  private allowDangerFullAccess:boolean;
  private sessionAccess=new Map<string,boolean>();
  private sessionAccessChecks=new Map<string,Promise<boolean>>();
  readonly desktopState: DesktopStateReader;
  constructor(private store: Store, config: Config, manager?: CodexManager) {
    this.catalog = new CodexSessionCatalog(config.codexSessionsDir);this.codexHome=config.codexHome;this.cwdAllowlist=config.codexCwdAllowlist;this.allowDangerFullAccess=config.allowDangerFullAccess;
    this.manager = manager ?? new CodexManager(config, store);
    this.desktopState = new DesktopStateReader(config.codexHome);
  }
  private normalizeCwd(cwd:string){return cwd.replace(/^\\\\\?\\/,'')}
  private pathAllowed(candidate:string,roots:string[]){return roots.some(root=>{const value=relative(root,candidate);return value===''||value!=='..'&&!value.startsWith(`..${sep}`)&&!isAbsolute(value)})}
  private async desktopRoots():Promise<string[]>{
    const candidates=new Set<string>();
    for(const project of await this.desktopState.getProjectsAsync())for(const root of project.rootPaths||[])if(root)candidates.add(this.normalizeCwd(root));
    for(const cwd of (await this.desktopState.getThreadCwdHints()).values())if(cwd)candidates.add(this.normalizeCwd(cwd));
    for(const thread of this.desktopState.getDbThreads())if(thread.cwd&&!thread.archived)candidates.add(this.normalizeCwd(thread.cwd));
    return Promise.all([...candidates].map(root=>realpath(resolve(root)).catch(()=>undefined))).then(values=>[...new Set(values.filter((value):value is string=>Boolean(value)))]);
  }
  private async canonicalRoots(includeCodexHome=false):Promise<string[]>{
    if(includeCodexHome){
      if(this.skillRoots)return this.skillRoots;
      const home=process.env.USERPROFILE||process.env.HOME||'';
      const base=[...this.cwdAllowlist,this.codexHome,...(home?[join(home,'.agents','skills')]:[]),join(this.codexHome,'plugins','cache')];
      const pending=Promise.all(base.map(root=>realpath(resolve(root)).catch(()=>undefined))).then(values=>[...new Set(values.filter((value):value is string=>Boolean(value)))]);
      this.skillRoots=pending;return pending;
    }
    if(!this.cwdRoots){
      this.cwdRoots=Promise.all(this.cwdAllowlist.map(root=>realpath(resolve(root)).catch(()=>undefined))).then(values=>[...new Set(values.filter((value):value is string=>Boolean(value)))]);
    }
    const [staticRoots,desktop]=await Promise.all([this.cwdRoots,this.desktopRoots()]);
    return [...new Set([...staticRoots,...desktop])];
  }
  private async requireAllowedPath(path:string,includeCodexHome=false){
    let candidate:string;
    try{candidate=await realpath(resolve(this.normalizeCwd(path)))}catch{throw Object.assign(new Error('path must exist'),{status:400})}
    const roots=await this.canonicalRoots(includeCodexHome);
    if(!this.pathAllowed(candidate,roots))throw Object.assign(new Error('path is outside CODEX_CWD_ALLOWLIST'),{status:403});
    return candidate;
  }
  private async isAllowedPath(path:string|undefined,includeCodexHome=false){if(!path)return false;try{await this.requireAllowedPath(path,includeCodexHome);return true}catch{return false}}
  private isProjectIdCwd(cwd:string,projectId?:string):boolean{const normalized=this.normalizeCwd(cwd);return Boolean(projectId)&&(normalized===projectId||basename(normalized)===projectId)}
  private bestCwd(projectId:string|undefined,...candidates:(string|undefined)[]):string{for(const candidate of candidates){if(!candidate)continue;const normalized=this.normalizeCwd(candidate);if(!isAbsolute(normalized))continue;if(this.isProjectIdCwd(normalized,projectId))continue;return normalized}return candidates.find(candidate=>Boolean(candidate))||''}
  private async effectiveCwd(id:string,cwd?:string):Promise<string|undefined>{
    const projectMap=await this.desktopState.getThreadProjectMap();
    const assigned=projectMap.get(id);
    if(cwd){const normalized=this.normalizeCwd(cwd);if(isAbsolute(normalized)&&!this.isProjectIdCwd(normalized,assigned?.projectId))return normalized}
    if(assigned){
      const projectRoots=await this.desktopState.getProjectRootMap();
      const root=projectRoots.find(project=>project.projectId===assigned.projectId)?.rootPath;
      if(root)return root;
    }
    return (await this.desktopState.getThreadCwdHints()).get(id);
  }
  private rememberSessionAccess(id:string,allowed:boolean){this.sessionAccess.set(id,allowed);return allowed}
  async canAccessSession(id:string,cwdHint?:string,forceRefresh=false):Promise<boolean>{
    if(cwdHint!==undefined)return this.rememberSessionAccess(id,await this.isAllowedPath(cwdHint));
    const cached=this.sessionAccess.get(id);if(!forceRefresh&&cached!==undefined)return cached;
    const existing=this.sessionAccessChecks.get(id);if(existing)return existing;
    const pending=(async()=>{try{const thread=await this.manager.read(id,false);const cwd=await this.effectiveCwd(id,thread.cwd);return this.rememberSessionAccess(id,await this.isAllowedPath(cwd))}catch{await this.catalog.refresh();const detail=await this.catalog.detail(id);const cwd=await this.effectiveCwd(id,detail?.cwd);return this.rememberSessionAccess(id,Boolean(detail&&cwd&&await this.isAllowedPath(cwd)))}})().finally(()=>this.sessionAccessChecks.delete(id));
    this.sessionAccessChecks.set(id,pending);return pending;
  }
  async canAccessEvent(event:{session:string;type?:string;metadata?:Record<string,unknown>}){
    // Only session_updated lifecycle events are authoritative for introducing
    // or changing a session's cwd. Other event metadata is item-owned data
    // and must not be able to grant access to an otherwise out-of-scope session.
    // Normal streaming events use the cached decision so every delta does not
    // trigger a full thread/read against app-server.
    if (event.type !== 'session_updated') return this.canAccessSession(event.session);
    const cwd=typeof event.metadata?.cwd==='string'?event.metadata.cwd:undefined;
    return this.canAccessSession(event.session,cwd,cwd===undefined);
  }
  private async requireAllowedSession(id:string){if(!await this.canAccessSession(id,undefined,true))throw Object.assign(new Error('session not found'),{status:404})}
  async list(): Promise<Session[]> {
    const rollouts = await this.catalog.refresh();
    let active: Session[] = [];
    try { active = (await this.manager.list(false)).map(thread => this.fromThread(thread)); } catch { /* durable rollout fallback */ }
    const merged = new Map<string,Session>(rollouts.map(item => [item.session_id, item]));
    for (const item of active) merged.set(item.session_id, { ...merged.get(item.session_id), ...item } as Session);
    const names=await this.indexNames();
    const deletedIds = await this.desktopState.getDeletedThreadIds();
    const dbThreads = this.desktopState.getDbThreads();
    const dbThreadById = new Map(dbThreads.map(thread => [thread.id, thread]));
    const hasDbThreadIndex = dbThreads.length > 0;
    const activeSessionIds = new Set(active.map(session => session.session_id));
    const all=[...merged.values()]
      .filter(item=>{
        if (deletedIds.has(item.session_id)) return false;
        const dbThread = dbThreadById.get(item.session_id);
        if (dbThread?.archived) return false;
        return !hasDbThreadIndex || dbThread !== undefined || activeSessionIds.has(item.session_id);
      })
      .map(item=>names.has(item.session_id)?{...item,title:names.get(item.session_id)!}:item);
    // Merge DB-only sessions (exist in state_5.sqlite but no rollout and not from app-server)
    const knownBeforeDb = new Set(all.map(s => s.session_id));
    const dbOnlySessions = dbThreads
      .filter(t => !t.archived && !knownBeforeDb.has(t.id) && !deletedIds.has(t.id))
      .map(t => ({
        session_id: t.id,
        title: (t.name || t.title || ['Codex ', t.id].join('')),
        status: (t.archived ? 'archived' : 'active') as 'archived' | 'active',
        pinned: false,
        cwd: t.cwd || '',
        created_at: new Date(t.created_at_ms || 0).toISOString(),
        updated_at: new Date(t.updated_at_ms || t.recency_at_ms || 0).toISOString(),
      }));
    all.push(...dbOnlySessions);
    const remoteSessionIds=new Set(this.store.remoteSessionIds());
    for(const session of all)if(remoteSessionIds.has(session.session_id)&&session.cwd)await this.desktopState.registerThread(session.session_id,session.cwd).catch(error=>console.warn('[remote:desktop] sidebar repair failed',error));
    // Enrich sessions with project info from Codex Desktop state
    const projectMap = await this.desktopState.getThreadProjectMap();
    const projectRoots = await this.desktopState.getProjectRootMap();
    const cwdHints = await this.desktopState.getThreadCwdHints();
    // Populate cwd from hints for active threads that have no rollout (no cwd)
    for (const session of all) {
      if (!session.cwd && cwdHints.has(session.session_id)) {
        session.cwd = cwdHints.get(session.session_id)!;
      }
    }
    const enriched = all.map(session => this.withProject(session, projectMap, projectRoots));
    // Keep every visible projectless thread. The remote client is a durable
    // history surface and must not silently hide older conversations.
    const knownIds = new Set(all.map(s => s.session_id));
    const ghostProjectless = await this.desktopState.getProjectlessSessions(knownIds, names);
    // Add sidebar-only ghost sessions (in sidebar orders but not in DB/rollouts)
    const ghostSidebar = await this.desktopState.getSidebarOnlySessions(knownIds, names);
    const enrichedWithGhosts = [...enriched, ...ghostProjectless, ...ghostSidebar];
	   const visible=this.merge(enrichedWithGhosts).filter(session => session.status !== 'archived' && !deletedIds.has(session.session_id));
    for(const id of deletedIds)this.sessionAccess.set(id,false);
    const roots=await this.canonicalRoots(false);
    const allowed:Session[]=[];
    for(const session of visible){
      let ok=false;
      if(session.cwd){try{ok=this.pathAllowed(await realpath(resolve(this.normalizeCwd(session.cwd))),roots)}catch{ok=false}}
      this.rememberSessionAccess(session.session_id,ok);
      if(ok)allowed.push(session);
    }
	   return allowed;
  }
  async refresh(): Promise<Session[]> { return this.list(); }
  async create(cwd: string,runtime:RuntimeConfig={}): Promise<Session> {
    const allowedCwd=await this.requireAllowedPath(cwd);
    const created = this.fromThread(await this.manager.start(allowedCwd,runtime));
    this.sessionAccess.set(created.session_id,true);
    await this.desktopState.registerThread(created.session_id,allowedCwd).catch(error=>console.warn('[remote:desktop] sidebar registration failed',error));
    const projectMap = await this.desktopState.getThreadProjectMap();
    const projectRoots = await this.desktopState.getProjectRootMap();
    return this.applyOverlay(this.withProject(created, projectMap, projectRoots));
  }
	 async detail(id: string): Promise<SessionDetail | undefined> {
      // Prefer the durable rollout as the authoritative message history. The
      // app-server can return a compacted/partial view of a thread and drops
      // pasted image data URLs, which regresses the web client's history and
      // image rendering. The rollout always carries the full history and the
      // original image references.
      const [rollout, thread] = await Promise.all([
        this.catalog.detail(id).catch(() => undefined),
        this.manager.read(id).catch(() => undefined),
      ]);
      const cwd = await this.effectiveCwd(id, thread?.cwd ?? rollout?.cwd);
      if (!cwd || !this.rememberSessionAccess(id, await this.isAllowedPath(cwd))) return undefined;
      if (rollout) {
        const session = this.applyOverlay({ ...rollout, cwd });
        const threadMessages = thread ? threadHistoryMessages(id, thread, session.updated_at) : [];
        const threadEvents = thread ? (thread.turns ?? []).flatMap((turn, turnIndex) => (turn.items ?? []).flatMap((item, itemIndex) => eventFromItem(id, turn.id, item, session.updated_at, turnIndex * 1000 + itemIndex + 1))) : [];
        return {
          ...session,
          messages: mergeHistoryMessages(rollout.messages, threadMessages),
          events: mergeEvents([...rollout.events, ...threadEvents], this.store.eventsForSession(id)),
        };
      }
      if (thread) {
        this.store.ensureSession(thread);
        const session = this.applyOverlay(this.fromThread(thread));
        if (cwd) session.cwd = cwd;
        const messages = threadHistoryMessages(id, thread, session.updated_at);
        const historyEvents = (thread.turns ?? []).flatMap((turn, turnIndex) => (turn.items ?? []).flatMap((item, itemIndex) => eventFromItem(id, turn.id, item, session.updated_at, turnIndex * 1000 + itemIndex + 1)));
        return { ...session, messages, events: mergeEvents(historyEvents, this.store.eventsForSession(id)) };
      }
      return undefined;
  }
  async update(id: string, changes: { title?: string; status?: SessionStatus; pinned?: boolean }): Promise<Session | undefined> { const detail=await this.detail(id);if(!detail)return undefined;if(changes.title)await this.manager.rename(id,changes.title).catch(()=>{});if(changes.status==='archived'||detail.status==='archived'&&changes.status==='active')await this.manager.archive(id,changes.status==='archived').catch(()=>{});this.store.updateOverlay(id,changes);return this.applyOverlay(detail) }
  async removeOverlay(id: string): Promise<boolean> { if(!await this.detail(id))return false;this.store.deleteOverlay(id);return true }
		 async message(id:string,input:UserInput[],runtime:RuntimeConfig={},clientId?:string){
		   await this.requireAllowedSession(id);
	    if(clientId){
	      const old=this.store.getIdempotent(id,clientId);
	      if(old?.status==='done')return old.response;
      if(old){
        const accepted=await this.acceptedTurn(id,clientId);if(accepted){this.store.finishIdempotent(id,clientId,accepted);return accepted}
        // Unknown outcomes are never replayed automatically: the original
        // turn may have been accepted even when its response was lost.
        throw Object.assign(new Error('client_id request outcome is uncertain; reconcile the Codex thread before retrying'),{status:409});
      }
	      if(!this.store.beginIdempotent(id,clientId))throw Object.assign(new Error('client_id request is already in progress'),{status:409});
	    }
	    try {
	      const safeInput=await Promise.all(input.map(async item=>item.type==='mention'||item.type==='localImage'?{...item,path:await this.requireAllowedPath(item.path)}:item.type==='skill'?{...item,path:await this.requireAllowedPath(item.path,true)}:item));
	      const result=await this.manager.startTurn(id,safeInput,runtime,clientId);if(clientId)this.store.finishIdempotent(id,clientId,result);return result;
	    } catch(error){
      if(clientId){if(error instanceof RpcTimeoutError||error instanceof RpcUnavailableError){const accepted=await this.acceptedTurn(id,clientId);if(accepted){this.store.finishIdempotent(id,clientId,accepted);return accepted}this.store.markPendingIdempotencyUncertain()}else this.store.failIdempotent(id,clientId)}
	      throw error;
	    }
  }
	 private async acceptedTurn(id:string,clientId:string){const stored=this.store.findAcceptedTurn(id,clientId);if(stored)return stored;try{const thread=await this.manager.read(id);for(const turn of [...(thread.turns??[])].reverse())for(const item of turn.items??[])if(item.type==='userMessage'&&(item.clientId===clientId||item.clientUserMessageId===clientId))return {thread_id:id,turn_id:turn.id,status:'started' as const}}catch{/* an unresolved timeout remains pending */}return undefined}
	 async cancel(id:string){await this.requireAllowedSession(id);return this.manager.interrupt(id)}
  models(){return this.manager.models()}
  async skills(cwd:string):Promise<SkillOption[]>{return this.manager.skills(await this.requireAllowedPath(cwd))}
	 async apps(threadId?:string):Promise<AppOption[]>{if(threadId)await this.requireAllowedSession(threadId);return this.manager.apps(threadId)}
  async defaults(){const defaults=await this.manager.defaults();return {...defaults,sandbox:defaults.sandbox==='danger-full-access'&&!this.allowDangerFullAccess?'workspace-write':defaults.sandbox,allowDangerFullAccess:this.allowDangerFullAccess}}
  async fileSearch(query:string,roots:string[]):Promise<FileSearchResult[]>{if(!roots.length)throw Object.assign(new Error('at least one search root is required'),{status:400});return this.manager.fileSearch(query,await Promise.all(roots.map(root=>this.requireAllowedPath(root))))}
  async readDirectory(path:string){return this.manager.readDirectory(await this.requireAllowedPath(path))}
  async openPath(path:string){
    const allowedPath=await this.requireAllowedPath(path,true);
    const platform=process.platform;
    const command=platform==='win32'?'explorer.exe':platform==='darwin'?'open':'xdg-open';
    const args=platform==='win32'?[allowedPath]:[allowedPath];
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(command,args,{detached:true,stdio:'ignore'});
      child.once('error',reject);
      child.once('spawn',()=>{child.unref();resolve()});
    });
  }
  async sync(cursor:number,clientStreamId?:string){const latest=this.store.latestCursor();const reset=Boolean(clientStreamId&&clientStreamId!==this.store.streamId)||(!clientStreamId&&cursor>0)||cursor>latest;const start=reset?0:cursor;const page=this.store.eventsAfter(start);const events=[];for(const event of page)if(await this.canAccessEvent(event))events.push(event);const next=page.at(-1)?.seq??start;return {cursor:next,events,stream_id:this.store.streamId,...(reset?{reset:true}:{}),has_more:next<latest}}
	 async projects(){const projects=await this.desktopState.getProjectsAsync();const visibleProjects=[] as typeof projects;for(const project of projects){const roots=(await Promise.all(project.rootPaths.map(async root=>await this.isAllowedPath(root)?root:undefined))).filter((root):root is string=>Boolean(root));if(roots.length)visibleProjects.push({...project,rootPaths:roots})}const allowedIds=new Set((await this.list()).map(session=>session.session_id));const sidebarOrderMap=await this.desktopState.getSidebarThreadOrder();const sidebarOrder=Object.fromEntries([...sidebarOrderMap].map(([key,ids])=>[key,ids.filter(id=>allowedIds.has(id))]));const allowedProjects=new Set(visibleProjects.map(project=>project.id));const projectOrder=(await this.desktopState.getProjectOrder()).filter(id=>allowedProjects.has(id));return {projects:visibleProjects,sidebarOrder,projectOrder}}
  async approvals(sessionId?:string){if(sessionId)await this.requireAllowedSession(sessionId);const approvals=this.store.listApprovals(sessionId);if(sessionId)return approvals.map(publicApproval);const allowed=await Promise.all(approvals.map(async approval=>await this.canAccessSession(approval.session_id)?approval:undefined));return allowed.filter((approval):approval is NonNullable<typeof approval>=>Boolean(approval)).map(publicApproval)}
	 async approval(id:string){const approval=this.store.getApproval(id);if(!approval)return undefined;await this.requireAllowedSession(approval.session_id);return publicApproval(approval)}
	 async decide(id:string,decision:'accept'|'decline'|'cancel',answers?:Record<string,string[]>){const approval=this.store.getApproval(id);if(!approval)throw Object.assign(new Error('approval request not found'),{status:404});await this.requireAllowedSession(approval.session_id);return this.manager.decide(id,decision,answers)}
  private fromThread(t:CodexThread):Session {this.store.ensureSession(t);return {session_id:t.id,title:t.name||t.preview||`Codex ${t.id}`,status:'active',pinned:false,cwd:t.cwd,created_at:new Date(t.createdAt*1000).toISOString(),updated_at:new Date(t.updatedAt*1000).toISOString(),...(t.path?{rollout_path:t.path}:{})}}
  private withProject(session:Session, projectMap:Map<string,{projectId:string;projectName:string;cwd?:string}>, projectRoots:Array<{projectId:string;projectName:string;rootPath:string}>):Session {
    const assigned = projectMap.get(session.session_id);
    if (assigned) {
      const rootPath = projectRoots.find(project => project.projectId === assigned.projectId)?.rootPath;
      return {...session,project_id:assigned.projectId,project_name:assigned.projectName,cwd:this.bestCwd(assigned.projectId,session.cwd,assigned.cwd,rootPath)};
    }
    if (!session.cwd) return session;
    const normalized = this.normalizeCwd(session.cwd);
    const sessionPath = resolve(normalized).toLowerCase();
    for (const project of projectRoots) {
      const projectPath = resolve(project.rootPath).toLowerCase();
      if (sessionPath===projectPath||sessionPath.startsWith(projectPath+sep)||sessionPath.startsWith(projectPath+'/')) {
        return {...session,project_id:project.projectId,project_name:project.projectName};
      }
    }
    return session;
  }
  private merge(items: Session[]): Session[] { return items.map(item => this.applyOverlay(item)).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updated_at.localeCompare(a.updated_at)||a.session_id.localeCompare(b.session_id)) }
  private applyOverlay<T extends Session>(session: T): T { const overlay=this.store.getOverlay(session.session_id);return {...session,title:overlay?.title||session.title,status:overlay?.status||session.status,pinned:Boolean(overlay?.pinned)} }
  private async indexNames(){const names=new Map<string,string>();try{for(const line of (await readFile(join(this.codexHome,'session_index.jsonl'),'utf8')).split(/\r?\n/)){if(!line.trim())continue;try{const item=JSON.parse(line);if(typeof item.id==='string'&&typeof item.thread_name==='string'&&item.thread_name.trim())names.set(item.id,item.thread_name.trim())}catch{/* isolate malformed rows */}}}catch{/* optional index */}return names}
}
function publicApproval(approval:any){const {raw_id,epoch,decision,...result}=approval;return result}
function threadHistoryMessages(sessionId:string,thread:CodexThread,timestamp:string){
  return (thread.turns ?? []).flatMap((turn, turnIndex) => (turn.items ?? []).map((item, itemIndex) => {
    if (item.type !== 'userMessage' && item.type !== 'agentMessage') return null;
    const role = (item.type === 'userMessage' ? 'user' : 'assistant') as 'user' | 'assistant';
    const parsed = role === 'user' ? parseUserInput(item.content,item.images) : { content: text(item.text ?? item.content), references: [] };
    const clientId = role === 'user' && typeof item.clientId === 'string' ? item.clientId : role === 'user' && typeof item.clientUserMessageId === 'string' ? item.clientUserMessageId : undefined;
    const content = cleanConversationText(parsed.content, role);
    if ((!content.trim() && !parsed.references.length) || isContextSummary(content)) return null;
    return { msg_id: item.id, ...(clientId ? { client_id: clientId } : {}), turn_id: turn.id, session_id: sessionId, role, content, ...(parsed.references.length ? { references: parsed.references } : {}), timestamp, seq: turnIndex * 1000 + itemIndex + 1 };
  }).filter((message): message is NonNullable<typeof message> => message !== null));
}
function mergeHistoryMessages(primary:any[],extra:any[]){
  const result=[...primary];
  const keys=new Set(result.map(messageHistoryKey));
  let nextSeq=Math.max(0,...result.map(message=>Number(message.seq)||0));
  for(const message of extra){const key=messageHistoryKey(message);if(keys.has(key))continue;keys.add(key);result.push({...message,seq:++nextSeq})}
  return result.sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.seq-b.seq);
}
function messageHistoryKey(message:any){return `${message.msg_id}\u0000${message.client_id??''}\u0000${message.role}\u0000${message.turn_id??''}\u0000${message.content}`}
function eventFromItem(session:string,turn:string,item:any,timestamp:string,seq:number):any[]{const metadata={turn_id:turn,item_id:item.id,item_type:item.type,status:item.status};if(item.type==='commandExecution')return [{id:`history:${item.id}`,type:'command_execution',session,timestamp,seq,content:item.aggregatedOutput||'',metadata:{...metadata,command:item.command,cwd:item.cwd,exit_code:item.exitCode}}];if(item.type==='fileChange')return [{id:`history:${item.id}`,type:'file_change',session,timestamp,seq,metadata:{...metadata,changes:item.changes}}];if(item.type==='reasoning'||item.type==='plan'){const content=text(item.summary??item.text??item.content);return content.trim()?[{id:`history:${item.id}`,type:'reasoning_status',session,timestamp,seq,content,metadata}]:[]}if(item.type==='contextCompaction')return [{id:`history:${item.id}`,type:'context_compaction',session,timestamp,seq,metadata}];if(item.type==='mcpToolCall'||item.type==='collabAgentToolCall')return [{id:`history:${item.id}`,type:'tool_call',session,timestamp,seq,content:text(item.result??item.error),metadata:{...metadata,server:item.server,tool:item.tool,arguments:item.arguments}}];if(item.type==='webSearch')return [{id:`history:${item.id}`,type:'web_search',session,timestamp,seq,content:String(item.query??''),metadata}];return []}
function mergeEvents(a:any[],b:any[]){const map=new Map<string,any>();for(const event of a)map.set(`${event.type}:${event.metadata?.item_id??event.id}:${event.metadata?.phase??''}`,event);for(const event of b){const key=`${event.type}:${event.metadata?.item_id??event.id}:${event.metadata?.phase??''}`;const existing=map.get(key);if(existing)map.set(key,{...event,seq:existing.seq,timestamp:existing.timestamp});else map.set(key,event)}return [...map.values()]}
function isContextSummary(textValue:string){return /^\s*#{1,3}\s*(?:Handoff Summary|Context (?:Summary|Compaction))\b/i.test(textValue)||/Another language model started to solve this problem/i.test(textValue)}
