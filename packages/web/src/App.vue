<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref} from 'vue';
import type {AppOption,ApprovalDecision,BridgeEvent,CodexDefaults,Message,ModelOption,PendingApproval,RuntimeConfig,Session,SkillOption,UserInput} from '@remote/shared';
import {api,clearAuth,connect,hasAuth,pair} from './api';
import {cacheEvents,cacheMessages,cacheSessions,cursor,db,setCursor,type Pending} from './db';
import {mergeBridgeEvent} from './composables/eventProjection';
import {replayInSessionOrder} from './composables/outbox';
import AppShell from './components/AppShell.vue';
import ApprovalSheet from './components/ApprovalSheet.vue';
import ComposerBox from './components/ComposerBox.vue';
import ConnectionBanner from './components/ConnectionBanner.vue';
import ConversationTimeline from './components/ConversationTimeline.vue';
import DiffViewer from './components/DiffViewer.vue';
import PairingSurface from './components/PairingSurface.vue';
import SessionSidebar from './components/SessionSidebar.vue';
import SettingsSurface from './components/SettingsSurface.vue';
import ThreadHeader from './components/ThreadHeader.vue';

const paired=ref(hasAuth()),pairBusy=ref(false),error=ref(''),createError=ref(''),sessions=ref<Session[]>([]),active=ref<Session|null>(null),messages=ref<Message[]>([]),events=ref<BridgeEvent[]>([]),approvals=ref<PendingApproval[]>([]),approvalBusy=ref(''),online=ref(navigator.onLine),wsState=ref<'connected'|'connecting'|'offline'>('offline'),appServer=ref<'ready'|'error'>('ready'),drawer=ref(false),sidebarHidden=ref(localStorage.getItem('sidebar-hidden')==='true'),creatingThread=ref(false),loadingSessions=ref(false),loadingThread=ref(false),activeTurn=ref(false),sending=ref(false),pending=ref<Pending[]>([]),settingsOpen=ref(false),approvalOpen=ref(false),diffOpen=ref(false),diff=ref(''),diffTitle=ref(''),theme=ref(localStorage.getItem('theme')||'system'),models=ref<ModelOption[]>([]),skills=ref<SkillOption[]>([]),apps=ref<AppOption[]>([]),defaults=ref<CodexDefaults>({}),capabilitiesLoading=ref(false);
let ws:WebSocket|null=null,retry:number|undefined,manualClose=false;
const pendingCount=computed(()=>pending.value.filter(item=>item.status!=='sent').length);
const pendingStates=computed(()=>Object.fromEntries(pending.value.map(item=>[item.id,item.status==='pending'?'已排队':item.status==='sending'?'发送中':item.status==='failed'?`发送失败：${item.error||'可重试'}`:'已接收'])));
function updateSession(updated:Session){const index=sessions.value.findIndex(item=>item.session_id===updated.session_id);if(index>=0)sessions.value[index]=updated;else sessions.value.unshift(updated);active.value=active.value?.session_id===updated.session_id?updated:active.value;void db.sessions.put(updated)}
function applyTheme(value:string){theme.value=value;localStorage.setItem('theme',value);document.documentElement.dataset.theme=value}
function toggleSidebar(){sidebarHidden.value=!sidebarHidden.value;localStorage.setItem('sidebar-hidden',String(sidebarHidden.value))}
async function doPair(code:string){pairBusy.value=true;error.value='';try{await pair(code);paired.value=true;await boot()}catch(e){error.value=e instanceof Error?e.message:'配对失败'}finally{pairBusy.value=false}}
async function loadSessions(refresh=false){loadingSessions.value=true;error.value='';try{const list=refresh?await api.refreshSessions():await api.sessions();sessions.value=list;await cacheSessions(list);appServer.value='ready'}catch(e){sessions.value=await db.sessions.orderBy('updated_at').reverse().toArray();error.value=e instanceof Error?e.message:'无法读取会话';appServer.value='error'}finally{loadingSessions.value=false}if(!active.value&&sessions.value[0])await select(sessions.value[0])}
async function select(session:Session){active.value=session;drawer.value=false;loadingThread.value=true;try{const detail=await api.session(session.session_id);messages.value=detail.messages;events.value=detail.events;await Promise.all([cacheMessages(detail.messages),cacheEvents(detail.events)]);approvals.value=await api.approvals(session.session_id);activeTurn.value=detail.events.slice().reverse().find(e=>e.type==='turn_started'||e.type==='turn_completed'||e.type==='turn_failed')?.type==='turn_started'}catch{messages.value=await db.messages.where('session_id').equals(session.session_id).sortBy('seq');events.value=await db.events.where('session').equals(session.session_id).sortBy('seq');approvals.value=[]}finally{loadingThread.value=false}}
function createThread(){void createInCwd(active.value?.cwd||'')}
function createInCwd(cwd:string){creatingThread.value=true;createError.value='';error.value='';api.create(cwd||'.').then(created=>{updateSession(created);void select(created)}).catch(e=>{error.value=e instanceof Error?e.message:'创建失败'}).finally(()=>{creatingThread.value=false})}
async function rename(){if(!active.value)return;const title=prompt('会话名称',active.value.title)?.trim();if(title)updateSession(await api.update(active.value.session_id,{title}))}
async function pin(session:Session){try{updateSession(await api.update(session.session_id,{pinned:!session.pinned}));sessions.value.sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updated_at.localeCompare(a.updated_at))}catch(e){error.value=e instanceof Error?e.message:'置顶失败'}}
async function archive(session:Session){try{const status=session.status==='archived'?'active':'archived';updateSession(await api.update(session.session_id,{status}));if(active.value?.session_id===session.session_id&&status==='archived')active.value=null}catch(e){error.value=e instanceof Error?e.message:'归档失败'}}
async function renameSession(session:Session){active.value=session;await rename()}
async function loadCapabilities(){if(!active.value||capabilitiesLoading.value)return;capabilitiesLoading.value=true;const requests=[api.models().then(value=>{models.value=value}),api.skills(active.value.cwd).then(value=>{skills.value=value}),api.apps(active.value.session_id).then(value=>{apps.value=value}),api.defaults().then(value=>{defaults.value=value})];const results=await Promise.allSettled(requests);const failed=results.find(x=>x.status==='rejected');if(failed&&results[3].status==='rejected')error.value=failed.reason instanceof Error?failed.reason.message:'无法读取 Codex 能力';capabilitiesLoading.value=false}
async function syncAll(){const current=await cursor();const result=await api.sync(current);let max=current;for(const event of result.events){max=Math.max(max,event.seq);await project(event)}await cacheEvents(result.events);await setCursor(max);await replayOutbox()}
async function project(event:BridgeEvent){await db.events.put(event);if(event.seq)await setCursor(Math.max(await cursor(),event.seq));if(event.session!==active.value?.session_id)return;const projected=mergeBridgeEvent({messages:messages.value,events:events.value,activeTurn:activeTurn.value},event);messages.value=projected.messages;events.value=projected.events;activeTurn.value=projected.activeTurn;const final=projected.messages.find(m=>m.msg_id===String(event.metadata?.item_id||event.id));if(final&&event.type==='assistant_message')await db.messages.put(final);if(event.type==='approval_requested'||event.type==='turn_started'||event.type==='turn_completed'||event.type==='turn_failed')approvals.value=await api.approvals(event.session).catch(()=>approvals.value)}
function openWs(){if(!paired.value||!online.value)return;clearTimeout(retry);manualClose=true;ws?.close();manualClose=false;wsState.value='connecting';ws=connect(message=>{if(message.type==='event'&&message.event)void project(message.event)});if(!ws)return;ws.onopen=async()=>{wsState.value='connected';try{await syncAll();appServer.value='ready'}catch{appServer.value='error'}};ws.onclose=()=>{wsState.value=online.value?'connecting':'offline';if(!manualClose&&online.value)retry=window.setTimeout(openWs,1800)}}
async function queueMessage(payload:{text:string;input:UserInput[];runtime:RuntimeConfig}){if(!active.value)return;const id=crypto.randomUUID();const item:Pending={id,session_id:active.value.session_id,content:payload.text,input:payload.input,runtime:payload.runtime,created_at:new Date().toISOString(),status:'pending'};await db.pending.put(item);pending.value.push(item);const refs=payload.input.filter(x=>x.type==='mention'||x.type==='image'||x.type==='skill').map(x=>x.type==='mention'?{type:'file' as const,label:x.name,path:x.path}:x.type==='image'?{type:'file' as const,label:x.name||'图片',path:''}:{type:'skill' as const,label:x.name,path:x.path});messages.value.push({msg_id:`local:${id}`,client_id:id,session_id:item.session_id,role:'user',content:payload.text,timestamp:item.created_at,seq:Number.MAX_SAFE_INTEGER-pending.value.length,...(refs.length?{references:refs}:{})});await db.messages.put(messages.value.at(-1)!);if(online.value)await replayOutbox()}
async function replayOutbox(){if(sending.value||!online.value)return;sending.value=true;const items=await db.pending.where('status').anyOf('pending','failed','sending').toArray();await replayInSessionOrder(items,item=>api.send(item.session_id,item.input??[{type:'text',text:item.content}],item.id,item.runtime),async item=>{await db.pending.put(item);const index=pending.value.findIndex(x=>x.id===item.id);if(index>=0)pending.value[index]={...item};else pending.value.push({...item})});sending.value=false}
async function retryFailed(){for(const item of pending.value.filter(x=>x.status==='failed')){item.status='pending';item.error=undefined;await db.pending.put(item)}await replayOutbox()}
async function cancel(){if(!active.value)return;try{await api.cancel(active.value.session_id)}catch(e){error.value=e instanceof Error?e.message:'停止失败'}}
async function decideApproval(approval:PendingApproval,decision:ApprovalDecision,answers?:Record<string,string[]>){approvalBusy.value=approval.request_id;error.value='';try{await api.decide(approval.request_id,decision,answers);approvals.value=approvals.value.filter(item=>item.request_id!==approval.request_id)}catch(e){error.value=e instanceof Error?e.message:'审批失败'}finally{approvalBusy.value=''}}
function openDiff(value:string,title:string){diff.value=value;diffTitle.value=title;diffOpen.value=true}
function network(){online.value=navigator.onLine;if(online.value){openWs()}else{wsState.value='offline';ws?.close()}}
async function boot(){pending.value=await db.pending.toArray();await loadSessions();await loadCapabilities();openWs()}
function unpair(){manualClose=true;ws?.close();clearAuth();paired.value=false;settingsOpen.value=false;sessions.value=[];active.value=null}
onMounted(()=>{applyTheme(theme.value);addEventListener('online',network);addEventListener('offline',network);if(paired.value)void boot()});
onBeforeUnmount(()=>{manualClose=true;removeEventListener('online',network);removeEventListener('offline',network);ws?.close();clearTimeout(retry)});
</script>

<template>
<PairingSurface v-if="!paired" :busy="pairBusy" :error="error" @pair="doPair"/>
<AppShell v-else :drawer-open="drawer" :sidebar-hidden="sidebarHidden" @close="drawer=false" @toggle-sidebar="toggleSidebar">
  <template #sidebar><SessionSidebar :sessions="sessions" :active-id="active?.session_id" :loading="loadingSessions" :error="error" @select="select" @refresh="loadSessions(true)" @pin="pin" @archive="archive" @rename="renameSession" @create="createThread" @create-in-cwd="createInCwd" :busy="creatingThread" @settings="settingsOpen=true"/></template>
  <section class="thread-workspace">
    <ConnectionBanner :online="online" :ws="wsState" :app-server="appServer" :pending="pendingCount"/>
    <ThreadHeader :session="active" :active-turn="activeTurn" @menu="drawer=true" @rename="rename" @review="approvalOpen=true"/>
    <ConversationTimeline :messages="messages" :events="events" :loading="loadingThread" :pending-states="pendingStates" @open-diff="openDiff"/>
    <button v-if="pending.some(x=>x.status==='failed')" class="retry-chip" @click="retryFailed">重试发送失败的消息</button>
    <ComposerBox :disabled="!active" :active-turn="activeTurn" :online="online" :queued="pendingCount" :sending="sending" :models="models" :skills="skills" :apps="apps" :defaults="defaults" :capabilities-loading="capabilitiesLoading" :cwd="active?.cwd || ''" @load-capabilities="loadCapabilities" @send="queueMessage" @cancel="cancel"/>
  </section>
  <template #overlay>
    <ApprovalSheet :approvals="approvals" :open="approvalOpen" :busy-id="approvalBusy" @close="approvalOpen=false" @decide="decideApproval"/>
    <DiffViewer :open="diffOpen" :diff="diff" :title="diffTitle" @close="diffOpen=false"/>
    <SettingsSurface :open="settingsOpen" :theme="theme" @close="settingsOpen=false" @theme="applyTheme" @unpair="unpair"/>
  </template>
</AppShell>
</template>
