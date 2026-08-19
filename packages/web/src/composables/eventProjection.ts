import { isSuppressedRuntimeNotice, type BridgeEvent, type Message, type MessageReference } from '@remote/shared';
import { sanitizeUserContent, stripNoticeLines } from './messages';

export interface ProjectedThread { messages: Message[]; events: BridgeEvent[]; activeTurn: boolean }

export function deriveActiveTurn(events: BridgeEvent[]): boolean {
  const turnStates = new Map<string, boolean>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq || a.timestamp.localeCompare(b.timestamp))) {
    const turnId = typeof event.metadata?.turn_id === 'string' ? event.metadata.turn_id : '';
    if (!turnId) continue;
    if (event.type === 'turn_started') turnStates.set(turnId, true);
    if (event.type === 'turn_completed' || event.type === 'turn_failed') turnStates.set(turnId, false);
  }
  return [...turnStates.values()].some(Boolean);
}

export function deriveActiveTurnId(events: BridgeEvent[]): string | undefined {
  const turnStates = new Map<string, boolean>();
  const sorted = [...events].sort((a, b) => a.seq - b.seq || a.timestamp.localeCompare(b.timestamp));
  for (const event of sorted) {
    const turnId = typeof event.metadata?.turn_id === 'string' ? event.metadata.turn_id : '';
    if (!turnId) continue;
    if (event.type === 'turn_started') turnStates.set(turnId, true);
    if (event.type === 'turn_completed' || event.type === 'turn_failed') turnStates.set(turnId, false);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const turnId = sorted[i].metadata?.turn_id;
    if (typeof turnId === 'string' && turnStates.get(turnId)) return turnId;
  }
  return undefined;
}

function eventIdentity(event: BridgeEvent): string {
  const itemId = typeof event.metadata?.item_id === 'string' ? event.metadata.item_id : '';
  const callId = typeof event.metadata?.call_id === 'string' ? event.metadata.call_id : '';
  const turnId = typeof event.metadata?.turn_id === 'string' ? event.metadata.turn_id : '';
  if (event.type === 'assistant_delta') {
    const deltaIndex = event.metadata?.delta_index ?? event.metadata?.index;
    return itemId && deltaIndex !== undefined
      ? event.type+':'+itemId+':'+turnId+':'+String(deltaIndex)
      : event.type+':id:'+event.id;
  }
  if (itemId || callId) return event.type+':'+(itemId || callId)+':'+String(event.metadata?.phase || '');
  return event.type+':id:'+event.id;
}

export function mergeBridgeEvent(state: ProjectedThread, event: BridgeEvent): ProjectedThread {
  const projectedEvent = event.content === undefined ? event : { ...event, content: stripNoticeLines(event.content) };
  if (projectedEvent.type === 'provider_error' && (!projectedEvent.content?.trim() || isSuppressedRuntimeNotice(projectedEvent.content))) return state;
  // Deduplicate both exact replay IDs and app-server replays that retain an
  // item/call identity but receive a new bridge ID.
  if (state.events.some(item => item.id === projectedEvent.id || eventIdentity(item) === eventIdentity(projectedEvent))) {
    return state;
  }

  if(projectedEvent.type==='user_message'){
    const references=projectedEvent.metadata?.references as MessageReference[]|undefined;
    const content=sanitizeUserContent(projectedEvent.content || '');
    if (!content.trim() && !references?.length) return state;
    const clientId=typeof projectedEvent.metadata?.client_id==='string'?projectedEvent.metadata.client_id:undefined;
    const turnId=typeof projectedEvent.metadata?.turn_id==='string'?projectedEvent.metadata.turn_id:undefined;
    const message:Message={msg_id:String(projectedEvent.metadata?.item_id||projectedEvent.id),...(clientId?{client_id:clientId}:{}),...(turnId?{turn_id:turnId}:{}),session_id:projectedEvent.session,role:'user',content,timestamp:projectedEvent.timestamp,seq:projectedEvent.seq,...(Array.isArray(references)&&references.length?{references}:[])};
    const index=state.messages.findIndex(item=>item.msg_id===message.msg_id
      ||Boolean(clientId&&item.client_id===clientId)
      ||Boolean(clientId&&item.msg_id===`local:${clientId}`)
      ||(item.role==='user'&&item.msg_id.startsWith('local:')&&item.content.trim()===message.content.trim()));
    const events=[...state.events,projectedEvent];
    if(index<0)return {...state,messages:[...state.messages,message],events};
    const messages=[...state.messages];messages[index]={...messages[index],...message};return {...state,messages,events};
  }

  if (projectedEvent.type === 'assistant_delta') {
    const messages = [...state.messages];
    const key = String(projectedEvent.metadata?.turn_id || 'stream');
    const streamId = `stream:${key}`;
    // If a final assistant_message already replaced the stream for this turn,
    // discard late-arriving deltas to avoid creating a phantom stream message.
    const hasFinal = messages.some(m => m.turn_id === key && m.role === 'assistant' && !m.msg_id.startsWith('stream:'));
    if (hasFinal) {
      return {...state, events:[...state.events, projectedEvent]};
    }
    const index = messages.findIndex(message => message.msg_id === streamId);
    if (index >= 0) {
      // Dedup: if this exact delta content was already appended (can happen on
      // syncAll replay), don't append again.
      messages[index] = { ...messages[index], content: messages[index].content + (projectedEvent.content || '') };
    } else {
      messages.push({ msg_id:streamId, turn_id:key, session_id:projectedEvent.session, role:'assistant', content:projectedEvent.content || '', timestamp:projectedEvent.timestamp, seq:projectedEvent.seq });
    }
    return { ...state, messages, events:[...state.events, projectedEvent] };
  }

  if (projectedEvent.type === 'assistant_message') {
    const key = String(projectedEvent.metadata?.turn_id || 'stream');
    const streamId = `stream:${key}`;
    const finalMessage:Message = { msg_id:String(projectedEvent.metadata?.item_id || projectedEvent.id), turn_id:key, session_id:projectedEvent.session, role:'assistant', content:sanitizeUserContent(projectedEvent.content || ''), timestamp:projectedEvent.timestamp, seq:projectedEvent.seq };
    const index = state.messages.findIndex(message => message.msg_id === streamId);
    const finalIndex = state.messages.findIndex(message => message.msg_id === finalMessage.msg_id);
    const duplicateFinalIndex = state.messages.findIndex(message => message.role === 'assistant'
      && message.session_id === finalMessage.session_id
      && message.turn_id === finalMessage.turn_id
      && message.content === finalMessage.content
      && !message.msg_id.startsWith('stream:'));
    const messages = [...state.messages];
    if (index >= 0) {
      // If we already accumulated more content via deltas than the final
      // message provides, prefer the streamed content (it may be more
      // complete due to timing). Otherwise use the final content.
      const streamed = messages[index].content;
      messages.splice(index, 1, {...finalMessage, content: streamed.length >= finalMessage.content.length ? streamed : finalMessage.content });
    } else if (finalIndex >= 0) {
      messages[finalIndex] = finalMessage;
    } else if (duplicateFinalIndex >= 0) {
      // A replay may use a different item id; keep the first canonical item.
    } else {
      messages.push(finalMessage);
    }
    return { ...state, messages, events:[...state.events, projectedEvent], activeTurn:state.activeTurn };
  }

  const activeTurn = projectedEvent.type === 'turn_started' ? true : projectedEvent.type === 'turn_completed' || projectedEvent.type === 'turn_failed' ? false : state.activeTurn;
  const events = [...state.events, projectedEvent];
  return { ...state, events, activeTurn };
}

export function projectBridgeEvents(messages:Message[],events:BridgeEvent[]):ProjectedThread{
  let state:ProjectedThread={messages:[...messages],events:[],activeTurn:false};
  for(const event of [...events].sort((a,b)=>a.seq-b.seq||a.timestamp.localeCompare(b.timestamp)))state=mergeBridgeEvent(state,event);
  return state;
}

export function safeEventText(event: BridgeEvent): string {
  if (event.content) return event.content;
  try { return JSON.stringify(event.metadata || {}, null, 2); } catch { return '无法显示事件详情'; }
}
