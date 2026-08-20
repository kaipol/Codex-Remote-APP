<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import type {AppOption,ApprovalDecision,BridgeEvent,CodexDefaults,Message,ModelOption,PendingApproval,ProjectInfo,RuntimeConfig,Session,SkillOption,UserInput} from '@remote/shared';
import {ApiError,api,clearAuth,configureServerUrl,connect,currentServerUrl,ensureAuth,ensureFreshToken,hasAuth,onAuthLost,onTokenRefreshed,pair,pairWithPassword} from './api';
import {cacheEvents,cacheMessages,cacheSessions,clearLocalState,clearTransportState,cursor,db,setCursor,setStreamId,streamId,hasOfflineCache,getMeta,type Pending} from './db';
import {deriveActiveTurn,deriveActiveTurnId,mergeBridgeEvent,projectBridgeEvents} from './composables/eventProjection';
import {DeferredSendError,isPendingCancellable,mergePendingMessages,pendingToMessage,replayInSessionOrder} from './composables/outbox';
import {drainSync} from './composables/sync';
import AppShell from './components/AppShell.vue';
import ApprovalSheet from './components/ApprovalSheet.vue';
import ComposerBox from './components/ComposerBox.vue';
import ConnectionBanner from './components/ConnectionBanner.vue';
import ConversationTimeline from './components/ConversationTimeline.vue';
import DiffViewer from './components/DiffViewer.vue';
import PairingSurface from './components/PairingSurface.vue';
import NewThreadDialog from './components/NewThreadDialog.vue';
import OutboxSheet from './components/OutboxSheet.vue';
import SessionSidebar from './components/SessionSidebar.vue';
import SettingsSurface from './components/SettingsSurface.vue';
import ThreadHeader from './components/ThreadHeader.vue';
import OfflineUnlockSurface from './components/OfflineUnlockSurface.vue';
import {offlinePasswordIsValid,hasOfflinePassword,verifyOfflinePassword,setOfflinePassword,clearOfflinePassword} from './composables/offlineAccess';

const paired=ref(false),pairBusy=ref(false),error=ref(''),sessions=ref<Session[]>([]),active=ref<Session|null>(null),messages=ref<Message[]>([]),events=ref<BridgeEvent[]>([]),approvals=ref<PendingApproval[]>([]),approvalBusy=ref(''),online=ref(navigator.onLine),wsState=ref<'connected'|'connecting'|'offline'>('offline'),appServer=ref<'ready'|'error'>('ready'),serverOffline=ref(false),drawer=ref(false),sidebarHidden=ref(localStorage.getItem('sidebar-hidden')==='true'),creatingThread=ref(false),loadingSessions=ref(false),loadingThread=ref(false),transitioning=ref(false),activeTurn=ref(false),sending=ref(false),pending=ref<Pending[]>([]),settingsOpen=ref(false),approvalOpen=ref(false),diffOpen=ref(false),diff=ref(''),diffTitle=ref(''),theme=ref(localStorage.getItem('theme')||'system'),models=ref<ModelOption[]>([]),skills=ref<SkillOption[]>([]),apps=ref<AppOption[]>([]),defaults=ref<CodexDefaults>({}),capabilitiesLoading=ref(false),allowedCwds=ref<string[]>([]),projectList=ref<ProjectInfo[]>([]),sidebarOrder=ref<Record<string,string[]>>({}),projectOrder=ref<string[]>([]),jumpTarget=ref<{id:string;key:number}|null>(null);
const offlineMode=ref(false),offlineUnlockOpen=ref(false),offlineBusy=ref(false),offlineError=ref(''),hasCache=ref(false),offlineHasPassword=ref(false),serverBack=ref(false);let offlineProbeTimer:number|undefined;
const draftCwd=ref(''),newThreadOpen=ref(false),createError=ref(''),initialServer=ref(currentServerUrl()),editingPending=ref<Pending|null>(null),editingSent=ref<Message|null>(null),pendingEditorText=ref(''),lastRuntime=ref<RuntimeConfig>({}),outboxOpen=ref(false);let ws:WebSocket|null=null,retryTimer:number|undefined,keepaliveTimer:number|undefined,sessionRefreshTimer:number|undefined,capabilityRefreshTimer:number|undefined,occupiedCheckTimer:number|undefined,sessionPollTimer:number|undefined,manualClose=false,capabilityReloadQueued=false;
let retryCount=0;
let wsGeneration=0;
let selectionGeneration=0;
const ourTurnIds=ref<Set<string>>(new Set());
const pendingCount=computed(()=>pending.value.length);
const pendingStates=computed(()=>Object.fromEntries(pending.value.map(item=>[item.id,item.status==='pending'?'已排队':item.status==='waiting'?'等待当前回复结束':item.status==='sending'?'发送中':item.status==='failed'?`发送失败：${item.error||'无法发送'}`:item.status==='quarantined'?`已隔离：${item.error||'需要重新配对或编辑后发送'}`:'已发送，等待对话同步'])));
const pendingCancellable=computed(()=>Object.fromEntries(pending.value.map(item=>[item.id,isPendingCancellable(item)])));
const cancelledPendingIds=new Set<string>();
function messagesWithPending(items:Message[],sessionId:string){return mergePendingMessages(items,pending.value.filter(item=>item.session_id===sessionId),sessionId)}
const externallyOccupied=computed(()=>{const s=active.value;if(!s||s.session_id==='draft'||!activeTurn.value)return false;const id=deriveActiveTurnId(events.value);return id?ourTurnIds.value.has(id)===false:false});
// Authoritative occupied signal: the server reports a writer lock held by
// another Codex process (e.g. the local Desktop app has the thread open). The
// turn-based externallyOccupied is kept as a real-time fallback that catches an
// in-progress Desktop turn even between lock-directory polls.
const occupied=computed(()=>{const s=active.value;return Boolean(s&&s.session_id!=='draft'&&s.occupied)||externallyOccupied.value});
watch(active,session=>{clearInterval(occupiedCheckTimer);occupiedCheckTimer=undefined;if(!session||session.session_id==='draft')return;occupiedCheckTimer=window.setInterval(()=>void settleActiveTurnAfterSync(),5000)},{immediate:true});
function updateSession(updated:Session){const index=sessions.value.findIndex(item=>item.session_id===updated.session_id);if(index>=0)sessions.value[index]=updated;else sessions.value.unshift(updated);active.value=active.value?.session_id===updated.session_id?updated:active.value;db.sessions.put(updated).catch(error=>console.warn('[remote:db] session cache write failed',error))}
function applyTheme(value:string){theme.value=value;localStorage.setItem('theme',value);document.documentElement.dataset.theme=value}
function toggleSidebar(){sidebarHidden.value=!sidebarHidden.value;localStorage.setItem('sidebar-hidden',String(sidebarHidden.value))}
async function doPair(mode:'code'|'password',value:string,serverUrl:string){pairBusy.value=true;error.value='';try{initialServer.value=configureServerUrl(serverUrl);await(mode==='password'?pairWithPassword(value):pair(value));await clearTransportState();paired.value=true;await boot()}catch(e){error.value=e instanceof Error?e.message:'配对失败'}finally{pairBusy.value=false}}
async function loadSessions(refresh=false){if(offlineMode.value){try{sessions.value=await db.sessions.orderBy('updated_at').reverse().toArray()}catch{sessions.value=[]};return}loadingSessions.value=true;error.value='';
  // Cache-first: show cached sessions from IndexedDB immediately so the
  // sidebar isn't empty during the (potentially slow) server scan. The
  // authoritative list replaces this once the API responds.
  if(!sessions.value.length&&!refresh){try{const cached=await db.sessions.orderBy('updated_at').reverse().toArray();if(cached.length)sessions.value=cached}catch(cacheError){console.warn('[remote:db] sessions precache read failed',cacheError)}}
  try{const list=refresh?await api.refreshSessions():await api.sessions();sessions.value=list;await cacheSessions(list);appServer.value='ready';serverOffline.value=false;if(active.value&&active.value.session_id!=='draft'&&!list.some(item=>item.session_id===active.value?.session_id)){selectionGeneration++;active.value=null;messages.value=[];events.value=[];approvals.value=[];activeTurn.value=false}}catch(e){try{sessions.value=await db.sessions.orderBy('updated_at').reverse().toArray()}catch(cacheError){console.warn('[remote:db] sessions fallback read failed',cacheError);sessions.value=[]}if(e instanceof ApiError){error.value=e.message||'无法读取会话';appServer.value='error'}else serverOffline.value=true}finally{loadingSessions.value=false}if(!active.value&&sessions.value[0])await select(sessions.value[0])}
function createThread(){if(offlineMode.value)return;startDraft(active.value?.cwd||allowedCwds.value[0]||'')}
function createInCwd(cwd:string){startDraft(allowedCwds.value.includes(cwd)?cwd:allowedCwds.value[0]||cwd)}
function openManualCreate(){createError.value='';newThreadOpen.value=true}
async function confirmCreate(cwd:string){creatingThread.value=true;createError.value='';error.value='';try{const created=await api.create(allowedCwds.value.includes(cwd)?cwd:allowedCwds.value[0]||cwd||'.');updateSession(created);newThreadOpen.value=false;await select(created)}catch(e){createError.value=e instanceof Error?e.message:'创建失败';newThreadOpen.value=true}finally{creatingThread.value=false}}
function startDraft(cwd:string){
  selectionGeneration++;
  const effectiveCwd=allowedCwds.value.includes(cwd)?cwd:allowedCwds.value[0]||cwd||'.';
  draftCwd.value=effectiveCwd;
  active.value={session_id:'draft',title:'新会话',status:'active',pinned:false,cwd:effectiveCwd,created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  messages.value=[];events.value=[];approvals.value=[];activeTurn.value=false;drawer.value=false;loadingThread.value=false;void loadCapabilities();
}
async function rename(){if(offlineMode.value||!active.value)return;const title=prompt('会话名称',active.value.title)?.trim();if(title)updateSession(await api.update(active.value.session_id,{title}))}
async function pin(session:Session){if(offlineMode.value)return;try{updateSession(await api.update(session.session_id,{pinned:!session.pinned}));sessions.value.sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updated_at.localeCompare(a.updated_at))}catch(e){error.value=e instanceof Error?e.message:'置顶失败'}}
async function archive(session:Session){if(offlineMode.value)return;try{const status=session.status==='archived'?'active':'archived';updateSession(await api.update(session.session_id,{status}));if(active.value?.session_id===session.session_id&&status==='archived')active.value=null}catch(e){error.value=e instanceof Error?e.message:'归档失败'}}
async function renameSession(session:Session){active.value=session;await rename()}
async function loadCapabilities(){
  if(!active.value)return;
  if(capabilitiesLoading.value){capabilityReloadQueued=true;return}
  capabilitiesLoading.value=true;
  try{
    do{
      capabilityReloadQueued=false;
      const target=active.value;if(!target)break;
      const requests=[
        api.models().then(value=>{models.value=value}),
        api.skills(target.cwd).then(value=>{if(active.value?.session_id===target.session_id)skills.value=value}),
        api.apps(target.session_id==='draft'?undefined:target.session_id).then(value=>{if(active.value?.session_id===target.session_id)apps.value=value}),
        api.defaults().then(value=>{defaults.value=value}),
      ];
      const results=await Promise.allSettled(requests);
      const failed=results.find(result=>result.status==='rejected');
      if(failed&&results[3].status==='rejected'&&!serverOffline.value)error.value=failed.reason instanceof Error?failed.reason.message:'无法读取 Codex 能力';
    }while(capabilityReloadQueued&&active.value)
  }finally{capabilitiesLoading.value=false}
}
let syncResetObserved=false;
let syncInFlight:Promise<void>|null=null;
let syncGeneration=0;
async function resetSyncState(){
  syncResetObserved=true;
  try{
    await db.transaction('rw',db.sessions,db.events,db.messages,db.pending,db.meta,async()=>{
      await db.sessions.clear();await db.events.clear();await db.messages.clear();
      // A stream reset means the server event history changed.  Retrying an
      // in-flight request automatically could create a duplicate turn, so keep
      // it quarantined until the user explicitly confirms a retry.
      await db.pending.toCollection().modify(item=>{if(item.status!=='sent'){item.status='quarantined';item.error='服务器同步状态已重置，请确认后重试'}});
      await db.pending.where('status').equals('sent').delete();
      // Preserve local-only credentials (offline access password) in meta; only
      // the transport cursor/stream_id track a resettable server stream.
      await db.meta.delete('cursor');await db.meta.delete('stream_id');
    });
  }catch(error){console.warn('[remote:db] sync reset failed',error)}
  try{pending.value=await db.pending.toArray()}catch(error){console.warn('[remote:db] pending read after reset failed',error);pending.value=[]}
  sessions.value=[];selectionGeneration++;active.value=null;approvals.value=[];events.value=[];messages.value=[];activeTurn.value=false;
}
async function syncAll(generation=wsGeneration){
  if(syncInFlight&&syncGeneration===generation)return syncInFlight;
  const priorSync=syncInFlight;
  if(priorSync){
    await priorSync.catch(()=>{});
    const replacementSync=syncInFlight;
    if(replacementSync)return replacementSync;
  }
  const run=async()=>{
    syncResetObserved=false;
    let requestedStream=await streamId();
    const apply=async(event:BridgeEvent)=>{if(generation===wsGeneration)await enqueueProject(event,generation)};
    const reset=async()=>{if(generation===wsGeneration)await resetSyncState()};
    const finalCursor=await drainSync(await cursor(),async value=>{const page=await api.sync(value,requestedStream);if(page.stream_id)requestedStream=page.stream_id;return page},apply,reset);
    if(generation!==wsGeneration)return;
    await setCursor(finalCursor);if(requestedStream)await setStreamId(requestedStream);
    if(syncResetObserved){await loadSessions(true);return}
    await settleActiveTurnAfterSync();
    await replayOutbox();
  };
  const tracked=run().finally(()=>{if(syncInFlight===tracked)syncInFlight=null});
  syncGeneration=generation;
  syncInFlight=tracked;
  return tracked;
}
let lastSidebarResync=0;
async function settleActiveTurnAfterSync(){
  const session=active.value;if(!session||session.session_id==='draft'||transitioning.value)return;
  // While OUR turn is actively streaming, do NOT replace messages/events from
  // a polled detail() snapshot — that overwrites the realtime WebSocket deltas
  // in flight with a stale snapshot and freezes the live UI. But when the
  // active turn is external (Desktop app generating a reply), there are no
  // WebSocket deltas to protect, so we MUST poll to surface the Desktop's
  // progress automatically.
  if(activeTurn.value&&!externallyOccupied.value)return;
  try{
    const detail=await api.session(session.session_id);
    if(!detail)return;
     if(detail.session_id!==active.value?.session_id)return;
     const stillActive=deriveActiveTurn(detail.events);
     const wasActive=activeTurn.value;
     await acknowledgePending(detail.messages);
     // Refresh the server-authoritative occupied flag so the notice/banner state
    // updates within the poll cadence when a Desktop tab opens/closes.
    active.value={...active.value,occupied:detail.occupied};
    // Lock files change silently (no app-server event), so periodically re-sync
    // the sidebar so occupied indicators stay fresh for other sessions too.
    if(Date.now()-lastSidebarResync>15000){lastSidebarResync=Date.now();void loadSessions(true).catch(()=>{})}
    messages.value=messagesWithPending(detail.messages,session.session_id);events.value=detail.events;activeTurn.value=stillActive;
    await Promise.all([cacheMessages(detail.messages),cacheEvents(detail.events)]);
    if(wasActive&&!stillActive)void replayOutbox();
  }catch{/* the next reconnect or detail load will re-check */}
}
function refreshSessionsSoon(){clearTimeout(sessionRefreshTimer);sessionRefreshTimer=window.setTimeout(()=>void loadSessions(true),150)}
async function acknowledgePending(items:Message[]){
  await acknowledgeClientIds(items.map(item=>item.client_id).filter((id):id is string=>Boolean(id)));
}
async function acknowledgeClientIds(ids:string[]){
  const clientIds=[...new Set(ids.filter(Boolean))];
  if(!clientIds.length)return;
  try{await Promise.all(clientIds.flatMap(clientId=>[db.pending.delete(clientId),db.messages.delete(`local:${clientId}`)]))}catch(error){console.warn('[remote:db] acknowledge delete failed',error)}
  const acknowledged=new Set(clientIds);
  pending.value=pending.value.filter(item=>!acknowledged.has(item.id));
  messages.value=messages.value.filter(item=>!(item.msg_id.startsWith('local:')&&item.client_id&&acknowledged.has(item.client_id)));
}
async function reconcilePending(){
  let queued:Pending[]=[];
  try{queued=await db.pending.toArray()}catch(error){console.warn('[remote:db] pending reconcile read failed',error)}
  const sessionIds=[...new Set(queued.map(item=>item.session_id).filter(id=>id&&id!=='draft'))];
  await Promise.all(sessionIds.map(async sessionId=>{
    const detail=await api.session(sessionId).catch(()=>undefined);
    if(detail)await acknowledgePending(detail.messages);
  }));
}
async function project(event:BridgeEvent){
  try{await db.events.put(event)}catch(error){console.warn('[remote:db] event cache write failed',error)}
  if(event.type==='session_updated')refreshSessionsSoon();
  // The app-server emits the canonical user_message event after it has
  // accepted a turn.  That event is the durable acknowledgement for the
  // outbox item, so clear it even when the user is currently viewing another
  // session.  Previously this happened only in the active-session branch,
  // leaving one "unsent" message stuck forever after a reconnect or a quick
  // session switch.
  if(event.type==='user_message'&&typeof event.metadata?.client_id==='string'){
    const clientId=event.metadata.client_id;
    await acknowledgeClientIds([clientId]);
  }
  const turnFinished=event.type==='turn_completed'||event.type==='turn_failed';
  if(event.session!==active.value?.session_id){
    if(event.seq)await setCursor(Math.max(await cursor(),event.seq));
    if(turnFinished)void replayOutbox();
    return;
  }
  const projected=mergeBridgeEvent({messages:messages.value,events:events.value,activeTurn:activeTurn.value},event);
  messages.value=projected.messages;events.value=projected.events;activeTurn.value=projected.activeTurn;
  if(event.type==='user_message'||event.type==='assistant_message')await cacheMessages(projected.messages.filter(message=>!message.msg_id.startsWith('stream:')));
  if(event.type==='approval_requested'||event.type==='turn_started'||turnFinished)approvals.value=await api.approvals(event.session).catch(()=>approvals.value);
  if(event.seq)await setCursor(Math.max(await cursor(),event.seq));
  if(turnFinished)void replayOutbox();
}
let projectQueue=Promise.resolve();
function enqueueProject(event:BridgeEvent,generation:number){projectQueue=projectQueue.then(()=>generation===wsGeneration?project(event):undefined).catch(reason=>{console.warn('[remote:projection] failed',reason)});return projectQueue}

// Reconnection with grace period and proactive token refresh.
// The core fix: access tokens expire (30 min TTL) and the WS upgrade endpoint
// rejects stale tokens with 401. Before each reconnect we refresh the token
// so the new WebSocket always carries a valid token.
const GRACE_PERIOD=5000;
let wsGraceTimer:number|undefined;
let wasConnectedOnce=false;
let wsReconnecting=false;

function getRetryDelay():number{
  const base=500;const factor=1.4;const max=8000;
  const delay=Math.min(base*Math.pow(factor,retryCount),max);
  const jitter=delay*0.2*(Math.random()*2-1);
  return Math.round(delay+jitter);
}

function showConnecting(){
  if(wasConnectedOnce){
    if(wsState.value==='connected')
      wsGraceTimer=window.setTimeout(()=>{if(wsState.value!=='connected')wsState.value='connecting'},GRACE_PERIOD);
  }else{
    wsState.value='connecting';clearTimeout(wsGraceTimer);
  }
}

async function openWs(){
  if(!paired.value||!online.value||wsReconnecting)return;
  wsReconnecting=true;
  const generation=++wsGeneration;
  clearTimeout(retryTimer);clearInterval(keepaliveTimer);
  const previous=ws;ws=null;previous?.close();
  showConnecting();
   const buffered:BridgeEvent[]=[];let synchronized=false;
   const socket=connect(message=>{if(generation!==wsGeneration)return;if(message.type==='capabilities'){void loadCapabilities();return}if(message.type==='event'&&message.event){if(synchronized)void enqueueProject(message.event,generation);else buffered.push(message.event)}});
  ws=socket;
  if(!socket){wsReconnecting=false;return}
   socket.onopen=async()=>{if(generation!==wsGeneration)return;console.info('[remote:ws] connected');clearTimeout(wsGraceTimer);wsState.value='connected';serverOffline.value=false;wasConnectedOnce=true;try{await syncAll(generation);if(generation!==wsGeneration||socket.readyState!==WebSocket.OPEN)return;while(buffered.length){if(generation!==wsGeneration||socket.readyState!==WebSocket.OPEN)return;const batch=buffered.splice(0).sort((a,b)=>a.seq-b.seq||a.timestamp.localeCompare(b.timestamp));for(const event of batch){if(generation!==wsGeneration||socket.readyState!==WebSocket.OPEN)return;await enqueueProject(event,generation)}}if(generation!==wsGeneration||socket.readyState!==WebSocket.OPEN)return;synchronized=true;appServer.value='ready';wsReconnecting=false;retryCount=0;void loadCapabilities()}catch(error){console.warn('[remote:sync] failed',error);appServer.value='error';socket.close()}};
  socket.onclose=()=>{
    if(generation!==wsGeneration)return;
    console.warn('[remote:ws] disconnected',{retryCount:retryCount+1});
    clearInterval(keepaliveTimer);clearTimeout(wsGraceTimer);wsReconnecting=false;
    if(!manualClose&&online.value){
      retryCount++;
      // Keep showing 'connected' during grace period for the first few retries
      if(wasConnectedOnce&&retryCount<=3){
        wsState.value='connected';
        wsGraceTimer=window.setTimeout(()=>{if(wsState.value!=='connected')wsState.value='connecting'},GRACE_PERIOD);
      }else{
        wsState.value='connecting';
      }
      // Refresh token before reconnecting — the access token may have expired
      // and the WS upgrade endpoint rejects stale tokens with 401.
      retryTimer=window.setTimeout(async()=>{
        if(!hasAuth())return;
        if(retryCount%3===0)await ensureFreshToken().catch(()=>{});
        openWs();
      },getRetryDelay());
    }else{
      wsState.value=online.value?'connecting':'offline';
    }
  };
  // Keepalive: detect stuck CONNECTING and force-close so onclose can reconnect
  let connectingSince=0;
  keepaliveTimer=window.setInterval(()=>{
    if(!ws){if(online.value&&!manualClose&&!wsReconnecting)openWs();return}
    if(ws.readyState===WebSocket.OPEN){connectingSince=0;return}
    if(ws.readyState===WebSocket.CONNECTING){
      if(!connectingSince)connectingSince=Date.now();
      else if(Date.now()-connectingSince>15000){connectingSince=0;ws.close()}
    }else clearInterval(keepaliveTimer);
  },5000);
}

// When REST API refreshes the token (e.g. after a 401 on a regular API call),
// proactively reconnect the WebSocket so it picks up the new token.
onTokenRefreshed(()=>{
  if(paired.value&&online.value&&!wsReconnecting){
    manualClose=true;clearTimeout(retryTimer);ws?.close();manualClose=false;
    void openWs();
  }
});

async function queueMessage(payload:{text:string;input:UserInput[];runtime:RuntimeConfig}){if(offlineMode.value||!active.value)return;
  lastRuntime.value=payload.runtime;
  let sessionId=active.value.session_id;let cwd=active.value.cwd;
  if(sessionId==='draft'){creatingThread.value=true;error.value='';try{const created=await api.create(draftCwd.value||cwd||'.');sessionId=created.session_id;updateSession(created);active.value=created;draftCwd.value='';await loadCapabilities()}catch(e){error.value=e instanceof Error?e.message:'创建失败';creatingThread.value=false;return}finally{creatingThread.value=false}}
  const id=crypto.randomUUID();const item:Pending={id,session_id:sessionId,content:payload.text,input:payload.input,runtime:payload.runtime,created_at:new Date().toISOString(),status:'pending'};const optimistic=pendingToMessage(item,pending.value.length);console.info('[remote:message] queued',{clientId:id,sessionId,inputCount:payload.input.length});try{await db.pending.put(item)}catch(cacheError){console.warn('[remote:message] pending cache write failed',{name:(cacheError as Error)?.name,message:(cacheError as Error)?.message,inner:(cacheError as {inner?:unknown})?.inner})}pending.value.push(item);messages.value=mergePendingMessages(messages.value,[item],sessionId);try{await db.messages.put(optimistic)}catch(cacheError){console.warn('[remote:message] message cache write failed',{name:(cacheError as Error)?.name,message:(cacheError as Error)?.message})}if(online.value)await replayOutbox()}
async function replayOutbox(){if(sending.value||!online.value||serverOffline.value)return;sending.value=true;let items:Pending[]=[];try{items=await db.pending.where('status').anyOf('pending','waiting','sending').toArray()}catch(cacheError){console.warn('[remote:message] pending cache read failed',{name:(cacheError as Error)?.name,message:(cacheError as Error)?.message})}const seen=new Set(items.map(value=>value.id));for(const value of pending.value){if(!seen.has(value.id)&&['pending','waiting','sending'].includes(value.status))items.push(value)}if(!items.length){sending.value=false;return}try{await replayInSessionOrder(items,async item=>{console.info('[remote:message] sending',{clientId:item.id,sessionId:item.session_id});try{const accepted=await api.send(item.session_id,item.input??[{type:'text',text:item.content}],item.id,item.runtime);if(accepted?.turn_id){const next=new Set(ourTurnIds.value);next.add(accepted.turn_id);if(next.size>50){const arr=[...next];ourTurnIds.value=new Set(arr.slice(arr.length-50))}else ourTurnIds.value=next}console.info('[remote:message] accepted',{clientId:item.id,sessionId:item.session_id,turnId:accepted.turn_id});return accepted}catch(error){if(error instanceof ApiError&&error.status===409&&/(?:active turn|already in progress|active writer|outcome is uncertain|reconcile the Codex thread before retrying)/i.test(error.message))throw new DeferredSendError();throw error}},async item=>{const index=pending.value.findIndex(x=>x.id===item.id);try{await db.pending.put(item)}catch(cacheError){console.warn('[remote:message] pending cache update failed',{name:(cacheError as Error)?.name,message:(cacheError as Error)?.message})}if(index>=0)pending.value[index]={...item};else if(item.status!=='sent')pending.value.push({...item});if(item.status==='failed')console.error('[remote:message] failed',{clientId:item.id,sessionId:item.session_id,error:item.error})},item=>cancelledPendingIds.has(item.id))}finally{for(const item of items)cancelledPendingIds.delete(item.id);sending.value=false}}
function messageInput(message:Message):UserInput[]{
  const input:UserInput[]=[];
  if(message.content.trim())input.push({type:'text',text:message.content});
  for(const reference of message.references??[]){
    if(reference.type==='file'&&reference.url?.startsWith('data:image/'))input.push({type:'image',url:reference.url,name:reference.label});
    else if(reference.type==='file'&&reference.path)input.push({type:'mention',name:reference.label,path:reference.path});
    else if(reference.type==='skill'&&reference.path)input.push({type:'skill',name:reference.label,path:reference.path});
  }
  return input;
}
function resendRuntime():RuntimeConfig{
  const fallback=defaults.value;
  return {
    model:lastRuntime.value.model||fallback.model,
    effort:lastRuntime.value.effort||fallback.effort,
    approvalPolicy:lastRuntime.value.approvalPolicy||fallback.approvalPolicy,
    sandbox:lastRuntime.value.sandbox||fallback.sandbox,
  };
}
function openPendingEditor(message:Message){
  const item=message.client_id?pending.value.find(value=>value.id===message.client_id):undefined;
  if(item){editingPending.value=item;editingSent.value=null;pendingEditorText.value=item.content;return}
  editingPending.value=null;editingSent.value=message;pendingEditorText.value=message.content;
}
async function savePendingEdit(){const item=editingPending.value;const content=pendingEditorText.value.trim();if(!item||!content)return;item.content=content;const textIndex=item.input?.findIndex(input=>input.type==='text')??-1;item.input=textIndex>=0?item.input!.map((input,index)=>index===textIndex?{type:'text' as const,text:content}:input):[{type:'text',text:content},...(item.input??[])];item.status='pending';item.error=undefined;try{await db.pending.put(item)}catch(error){console.warn('[remote:db] pending edit cache update failed',error)}const index=pending.value.findIndex(value=>value.id===item.id);if(index>=0)pending.value[index]={...item};messages.value=messages.value.map(message=>message.client_id===item.id?{...message,content}:message);try{await db.messages.put({msg_id:`local:${item.id}`,client_id:item.id,session_id:item.session_id,role:'user',content,timestamp:item.created_at,seq:Number.MAX_SAFE_INTEGER-(index>=0?index:0)})}catch(error){console.warn('[remote:db] edited message cache write failed',error)}editingPending.value=null;pendingEditorText.value='';await replayOutbox()}
async function cancelQueued(item:Pending){
  if(!isPendingCancellable(item))return;
  cancelledPendingIds.add(item.id);
  try{await Promise.all([db.pending.delete(item.id),db.messages.delete(`local:${item.id}`)])}catch(error){console.warn('[remote:db] pending cancel failed',error)}
  pending.value=pending.value.filter(value=>value.id!==item.id);
  messages.value=messages.value.filter(message=>message.client_id!==item.id);
  if(!sending.value)cancelledPendingIds.delete(item.id);
}
async function cancelPendingMessage(){const item=editingPending.value;if(!item)return;await cancelQueued(item);editingPending.value=null;pendingEditorText.value=''}
async function saveSentEdit(){
  const message=editingSent.value;const content=pendingEditorText.value.trim();
  if(!message||!content)return;
  if(active.value?.session_id!==message.session_id){
    const target=sessions.value.find(session=>session.session_id===message.session_id);
    if(target)await select(target);else return;
  }
  editingSent.value=null;pendingEditorText.value='';
  await queueMessage({text:content,input:messageInput({...message,content}),runtime:resendRuntime()});
}
function cancelSentEdit(){editingSent.value=null;pendingEditorText.value=''}
async function decideApproval(approval:PendingApproval,decision:ApprovalDecision,answers?:Record<string,string[]>){approvalBusy.value=approval.request_id;error.value='';try{await api.decide(approval.request_id,decision,answers);approvals.value=approvals.value.filter(item=>item.request_id!==approval.request_id)}catch(e){error.value=e instanceof Error?e.message:'审批失败'}finally{approvalBusy.value=''}}
function openDiff(value:string,title:string){diff.value=value;diffTitle.value=title;diffOpen.value=true}
function refreshCapabilitiesOnFocus(){if(paired.value&&online.value&&document.visibilityState==='visible')void loadCapabilities()}
function network(){online.value=navigator.onLine;if(online.value){openWs();void loadCapabilities()}else{wsState.value='offline';clearInterval(keepaliveTimer);clearTimeout(wsGraceTimer);ws?.close()}}
async function boot(){try{await db.transaction('rw',db.pending,async()=>{await db.pending.where('status').equals('sending').modify(item=>{item.status='pending'})})}catch(error){console.warn('[remote:db] pending startup cleanup failed',error)}try{pending.value=await db.pending.toArray()}catch(error){console.warn('[remote:db] pending read failed',error);pending.value=[]}try{allowedCwds.value=await api.cwdRoots()}catch{allowedCwds.value=[]};try{const proj=await api.projects();projectList.value=proj.projects;sidebarOrder.value=proj.sidebarOrder;projectOrder.value=proj.projectOrder}catch{projectList.value=[];sidebarOrder.value={};projectOrder.value=[]};await loadSessions();await loadCapabilities();clearInterval(capabilityRefreshTimer);capabilityRefreshTimer=window.setInterval(refreshCapabilitiesOnFocus,30000);clearInterval(sessionPollTimer);sessionPollTimer=window.setInterval(()=>{if(paired.value&&online.value&&document.visibilityState==='visible')void loadSessions().catch(()=>{})},15000);openWs();void reconcilePending()}
async function unpair(){manualClose=true;stopOfflineProbe();clearTimeout(retryTimer);clearInterval(keepaliveTimer);clearTimeout(wsGraceTimer);clearTimeout(sessionRefreshTimer);clearInterval(capabilityRefreshTimer);clearInterval(occupiedCheckTimer);clearInterval(sessionPollTimer);wasConnectedOnce=false;ws?.close();await api.revoke().catch(()=>{});await clearAuth(false);await clearLocalState();paired.value=false;offlineMode.value=false;settingsOpen.value=false;sessions.value=[];selectionGeneration++;active.value=null;pending.value=[]}
onAuthLost(()=>{manualClose=true;clearTimeout(retryTimer);clearInterval(keepaliveTimer);clearTimeout(wsGraceTimer);clearTimeout(sessionRefreshTimer);clearInterval(capabilityRefreshTimer);clearInterval(occupiedCheckTimer);clearInterval(sessionPollTimer);wasConnectedOnce=false;ws?.close();paired.value=false;sessions.value=[];selectionGeneration++;active.value=null;pending.value=[];error.value='登录已过期，请重新配对';void checkOfflineAvailability()});
onMounted(async()=>{applyTheme(theme.value);addEventListener('online',network);addEventListener('offline',network);addEventListener('visibilitychange',refreshCapabilitiesOnFocus);addEventListener('focus',refreshCapabilitiesOnFocus);await ensureAuth();void checkOfflineAvailability();let verified=false;if(hasAuth()){for(let attempt=0;attempt<3&&hasAuth();attempt++){if(attempt>0)await new Promise<void>(resolve=>setTimeout(resolve,800*(attempt+1)));verified=await ensureFreshToken();if(verified)break}}paired.value=verified;if(paired.value){hasCache.value=false;await boot()}else{paired.value=false;await checkOfflineAvailability()}});
onBeforeUnmount(()=>{manualClose=true;removeEventListener('online',network);removeEventListener('offline',network);removeEventListener('visibilitychange',refreshCapabilitiesOnFocus);removeEventListener('focus',refreshCapabilitiesOnFocus);ws?.close();clearTimeout(retryTimer);clearInterval(keepaliveTimer);clearTimeout(wsGraceTimer);clearTimeout(sessionRefreshTimer);clearInterval(capabilityRefreshTimer);clearInterval(occupiedCheckTimer);clearInterval(sessionPollTimer);stopOfflineProbe()});
async function select(session:Session){
  if(offlineMode.value){await selectOffline(session);return}
  const generation=++selectionGeneration;
  if(active.value?.session_id==='draft'&&session.session_id!=='draft')draftCwd.value='';
  ourTurnIds.value=new Set();
  active.value=session;drawer.value=false;loadingThread.value=true;transitioning.value=true;messages.value=[];events.value=[];approvals.value=[];activeTurn.value=false;void loadCapabilities();
  // Cache-first: show cached thread content from IndexedDB immediately so the
  // timeline isn't blank while the authoritative detail loads. The fresh API
  // response replaces this once it arrives.
  if(session.session_id!=='draft'){try{const [cachedMessages,cachedEvents]=await Promise.all([db.messages.where('session_id').equals(session.session_id).sortBy('seq'),db.events.where('session').equals(session.session_id).sortBy('seq')]);if(generation===selectionGeneration&&messages.value.length===0&&events.value.length===0){const projected=projectBridgeEvents(cachedMessages,cachedEvents);messages.value=messagesWithPending(projected.messages,session.session_id);events.value=projected.events;activeTurn.value=projected.activeTurn}}catch(cacheError){console.warn('[remote:db] thread precache read failed',cacheError)}}
  try{
    let detail=await api.session(session.session_id);
    if(!detail){for(let i=0;i<3;i++){await new Promise(r=>setTimeout(r,400));if(generation!==selectionGeneration)return;detail=await api.session(session.session_id);if(detail)break}}
    if(generation!==selectionGeneration)return;
    if(detail){
      const nextApprovals=await api.approvals(session.session_id).catch(()=>[]);
      if(generation!==selectionGeneration)return;
      await acknowledgePending(detail.messages);
      if(generation!==selectionGeneration)return;
      messages.value=messagesWithPending(detail.messages,session.session_id);events.value=detail.events;approvals.value=nextApprovals;activeTurn.value=deriveActiveTurn(detail.events);
      active.value={...active.value,occupied:detail.occupied};
      await Promise.all([cacheMessages(detail.messages),cacheEvents(detail.events)]);
    }else{messages.value=[];events.value=[];approvals.value=[];activeTurn.value=false}
  }catch{
    if(generation!==selectionGeneration)return;
    let cachedMessages:Message[]=[];let cachedEvents:BridgeEvent[]=[];
    try{[cachedMessages,cachedEvents]=await Promise.all([db.messages.where('session_id').equals(session.session_id).sortBy('seq'),db.events.where('session').equals(session.session_id).sortBy('seq')])}catch(error){console.warn('[remote:db] cached thread read failed',error)}
    if(generation!==selectionGeneration)return;
    const projected=projectBridgeEvents(cachedMessages,cachedEvents);messages.value=messagesWithPending(projected.messages,session.session_id);events.value=projected.events;approvals.value=[];activeTurn.value=projected.activeTurn;
  }finally{if(generation===selectionGeneration){loadingThread.value=false;transitioning.value=false}}
}
async function openPendingConversation(item:Pending){
  outboxOpen.value=false;
  const target=sessions.value.find(session=>session.session_id===item.session_id);
  if(!target)return;
  await select(target);
  jumpTarget.value={id:`local:${item.id}`,key:Date.now()};
}
async function cancel(){if(offlineMode.value||!active.value)return;try{await api.cancel(active.value.session_id)}catch(e){error.value=e instanceof Error?e.message:'停止失败'}activeTurn.value=false}

// ---- Offline cached-access mode ----
// Lets the mobile device view cached conversations without the local server running.
// Uses IndexedDB sessions/messages/events that were synced while online. A local
// PBKDF2-hashed password gates access so the cached data isn't readable by anyone
// who picks up the phone.
async function checkOfflineAvailability(){try{const [cache,password]=await Promise.all([hasOfflineCache(),hasOfflinePassword()]);hasCache.value=cache;offlineHasPassword.value=password}catch{hasCache.value=false;offlineHasPassword.value=false}}
async function openOfflineUnlock(){offlineHasPassword.value=await hasOfflinePassword();offlineUnlockOpen.value=true;offlineError.value=''}
async function doOfflineUnlock(password:string){offlineBusy.value=true;offlineError.value='';try{const existing=await hasOfflinePassword();if(!existing){if(!offlinePasswordIsValid(password)){offlineError.value='离线访问密码至少 8 位';return}await setOfflinePassword(password);offlineHasPassword.value=true}else{const ok=await verifyOfflinePassword(password);if(!ok){offlineError.value='离线访问密码错误';return}}await enterOfflineMode()}catch(e){offlineError.value=e instanceof Error?e.message:'无法进入离线模式'}finally{offlineBusy.value=false}}
async function enterOfflineMode(){
  offlineMode.value=true;offlineUnlockOpen.value=false;error.value='';
  // Load everything from IndexedDB cache only — no server contact.
  try{sessions.value=await db.sessions.orderBy('updated_at').reverse().toArray()}catch(cacheError){console.warn('[remote:offline] sessions load failed',cacheError);sessions.value=[]}
  try{pending.value=await db.pending.toArray()}catch(cacheError){console.warn('[remote:offline] pending load failed',cacheError);pending.value=[]}
  allowedCwds.value=[];projectList.value=[];sidebarOrder.value={};projectOrder.value=[];
  if(sessions.value[0])await selectOffline(sessions.value[0]);
  startOfflineProbe();
}
function exitOfflineMode(){stopOfflineProbe();offlineMode.value=false;sessions.value=[];active.value=null;messages.value=[];events.value=[];pending.value=[];void checkOfflineAvailability()}
async function selectOffline(session:Session){
  active.value=session;drawer.value=false;loadingThread.value=true;transitioning.value=true;messages.value=[];events.value=[];approvals.value=[];activeTurn.value=false;
  if(session.session_id==='draft'){loadingThread.value=false;transitioning.value=false;return}
  try{const [cachedMessages,cachedEvents]=await Promise.all([db.messages.where('session_id').equals(session.session_id).sortBy('seq'),db.events.where('session').equals(session.session_id).sortBy('seq')]);const projected=projectBridgeEvents(cachedMessages,cachedEvents);messages.value=messagesWithPending(projected.messages,session.session_id);events.value=projected.events;activeTurn.value=projected.activeTurn}catch(cacheError){console.warn('[remote:offline] thread load failed',cacheError)}
  finally{loadingThread.value=false;transitioning.value=false}
}
// Periodically probe the last-known server URL. When it comes back, surface a
// reconnect banner so the user can return to the full online mode.
function startOfflineProbe(){stopOfflineProbe();offlineProbeTimer=window.setInterval(async()=>{if(!navigator.onLine)return;const base=currentServerUrl();if(!base)return;try{const r=await fetch(base+'/api/pair/methods',{headers:{'content-type':'application/json'}});if(r.ok)serverBack.value=true}catch{/* still down */}},10000)}
function stopOfflineProbe(){clearInterval(offlineProbeTimer);offlineProbeTimer=undefined;serverBack.value=false}
async function reconnectFromOffline(){
  stopOfflineProbe();offlineMode.value=false;
  await ensureAuth();let verified=false;
  if(hasAuth()){verified=await ensureFreshToken()}
  if(verified){paired.value=true;sessions.value=[];active.value=null;messages.value=[];events.value=[];await boot()}
  else{paired.value=false;active.value=null;await checkOfflineAvailability()}
}
</script>

<template>
<PairingSurface v-if="!paired&&!offlineUnlockOpen&&!offlineMode" :busy="pairBusy" :error="error" :initial-server="initialServer" :has-offline="hasCache" @pair="doPair" @offline="openOfflineUnlock"/>
<OfflineUnlockSurface v-else-if="offlineUnlockOpen" :busy="offlineBusy" :error="offlineError" :has-password="offlineHasPassword" @unlock="doOfflineUnlock" @exit="offlineUnlockOpen=false"/>
<AppShell v-else :drawer-open="drawer" :sidebar-hidden="sidebarHidden" @close="drawer=false" @toggle-sidebar="toggleSidebar">
  <template #sidebar><SessionSidebar :sessions="sessions" :active-id="active?.session_id" :loading="loadingSessions" :error="error" :projects="projectList" :sidebar-order="sidebarOrder" :project-order="projectOrder" @select="select" @refresh="loadSessions(true)" @pin="pin" @archive="archive" @rename="renameSession" @create="createThread" @create-in-cwd="createInCwd" @manual-create="openManualCreate" :busy="creatingThread" :offline-mode="offlineMode" @settings="settingsOpen=true"/></template>
  <section class="thread-workspace">
    <ConnectionBanner :online="online" :ws="wsState" :app-server="appServer" :pending="offlineMode?0:pendingCount" :server-offline="serverOffline" :offline="offlineMode" :server-back="serverBack" @open-outbox="outboxOpen=true" @reconnect="reconnectFromOffline"/>
    <ThreadHeader :session="active" :active-turn="activeTurn" :occupied="occupied" :offline-mode="offlineMode" @menu="drawer=true" @rename="rename" @review="approvalOpen=true"/>
    <ConversationTimeline :messages="messages" :events="events" :loading="loadingThread" :pending-states="pendingStates" :pending-cancellable="pendingCancellable" :active-turn="activeTurn" :occupied="occupied" :jump-target="jumpTarget" @open-diff="openDiff" @edit-pending="openPendingEditor"/>
    <ComposerBox :disabled="!active||offlineMode" :active-turn="activeTurn" :occupied="occupied" :online="online" :queued="pendingCount" :sending="sending" :models="models" :skills="skills" :apps="apps" :defaults="defaults" :capabilities-loading="capabilitiesLoading" :offline-mode="offlineMode" :cwd="active?.cwd || ''" @load-capabilities="loadCapabilities" @send="queueMessage" @cancel="cancel"/>
  </section>
  <template #overlay>
    <ApprovalSheet :approvals="approvals" :open="approvalOpen" :busy-id="approvalBusy" @close="approvalOpen=false" @decide="decideApproval"/>
    <DiffViewer :open="diffOpen" :diff="diff" :title="diffTitle" @close="diffOpen=false"/>
    <SettingsSurface :open="settingsOpen" :theme="theme" :offline-mode="offlineMode" @close="settingsOpen=false" @theme="applyTheme" @unpair="unpair" @exit-offline="exitOfflineMode"/>
    <NewThreadDialog :open="newThreadOpen" :initial="active?.cwd||''" :busy="creatingThread" :error="createError" @close="newThreadOpen=false" @create="confirmCreate"/>
    <OutboxSheet :open="outboxOpen" :items="pending" :sessions="sessions" @close="outboxOpen=false" @open-conversation="openPendingConversation" @cancel="cancelQueued"/>
    <div v-if="editingPending" class="modal-scrim" @click.self="editingPending=null"><form class="pending-editor" @submit.prevent="savePendingEdit"><header><div><strong>编辑待发送消息</strong><small>发送会使用修改后的内容；取消该消息会将其从队列移除。</small></div><button type="button" class="icon-button" aria-label="关闭" @click="editingPending=null">×</button></header><textarea v-model="pendingEditorText" aria-label="待发送消息"></textarea><footer><button type="button" class="text-button danger-text" @click="cancelPendingMessage">取消该消息</button><span></span><button type="button" class="text-button" @click="editingPending=null">取消编辑</button><button class="primary" :disabled="!pendingEditorText.trim()">发送修改</button></footer></form></div>
    <div v-if="editingSent" class="modal-scrim" @click.self="cancelSentEdit"><form class="pending-editor" @submit.prevent="saveSentEdit"><header><div><strong>编辑已发送消息</strong><small>会作为一条新的消息发送，原对话记录不会被改写。</small></div><button type="button" class="icon-button" aria-label="关闭" @click="cancelSentEdit">×</button></header><textarea v-model="pendingEditorText" aria-label="已发送消息"></textarea><footer><span></span><button type="button" class="text-button" @click="cancelSentEdit">取消编辑</button><button class="primary" :disabled="!pendingEditorText.trim()">发送修改</button></footer></form></div>
  </template>
</AppShell>
</template>
