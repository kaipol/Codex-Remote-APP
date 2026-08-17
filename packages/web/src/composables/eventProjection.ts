import type { BridgeEvent, Message, MessageReference } from '@remote/shared';

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

export function mergeBridgeEvent(state: ProjectedThread, event: BridgeEvent): ProjectedThread {
  // Deduplicate: skip events we've already seen (e.g. from syncAll replay)
  if (state.events.some(item => item.id === event.id)) {
    return state;
  }

  if(event.type==='user_message'){
    const clientId=typeof event.metadata?.client_id==='string'?event.metadata.client_id:undefined;
    const turnId=typeof event.metadata?.turn_id==='string'?event.metadata.turn_id:undefined;
    const references=event.metadata?.references as MessageReference[]|undefined;
    const message:Message={msg_id:String(event.metadata?.item_id||event.id),...(clientId?{client_id:clientId}:{}),...(turnId?{turn_id:turnId}:{}),session_id:event.session,role:'user',content:event.content||'',timestamp:event.timestamp,seq:event.seq,...(Array.isArray(references)&&references.length?{references}:[])};
    const index=state.messages.findIndex(item=>item.msg_id===message.msg_id
      ||Boolean(clientId&&item.client_id===clientId)
      ||Boolean(clientId&&item.msg_id===`local:${clientId}`)
      ||(item.role==='user'&&item.msg_id.startsWith('local:')&&item.content.trim()===message.content.trim()));
    const events=[...state.events,event];
    if(index<0)return {...state,messages:[...state.messages,message],events};
    const messages=[...state.messages];messages[index]={...messages[index],...message};return {...state,messages,events};
  }

  if (event.type === 'assistant_delta') {
    const messages = [...state.messages];
    const key = String(event.metadata?.turn_id || 'stream');
    const streamId = `stream:${key}`;
    // If a final assistant_message already replaced the stream for this turn,
    // discard late-arriving deltas to avoid creating a phantom stream message.
    const hasFinal = messages.some(m => m.turn_id === key && m.role === 'assistant' && !m.msg_id.startsWith('stream:'));
    if (hasFinal) {
      return {...state, events:[...state.events, event]};
    }
    const index = messages.findIndex(message => message.msg_id === streamId);
    if (index >= 0) {
      // Dedup: if this exact delta content was already appended (can happen on
      // syncAll replay), don't append again.
      messages[index] = { ...messages[index], content: messages[index].content + (event.content || '') };
    } else {
      messages.push({ msg_id:streamId, turn_id:key, session_id:event.session, role:'assistant', content:event.content || '', timestamp:event.timestamp, seq:event.seq });
    }
    return { ...state, messages, events:[...state.events, event] };
  }

  if (event.type === 'assistant_message') {
    const key = String(event.metadata?.turn_id || 'stream');
    const streamId = `stream:${key}`;
    const finalMessage:Message = { msg_id:String(event.metadata?.item_id || event.id), turn_id:key, session_id:event.session, role:'assistant', content:event.content || '', timestamp:event.timestamp, seq:event.seq };
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
    return { ...state, messages, events:[...state.events, event], activeTurn:state.activeTurn };
  }

  const activeTurn = event.type === 'turn_started' ? true : event.type === 'turn_completed' || event.type === 'turn_failed' ? false : state.activeTurn;
  const events = [...state.events, event];
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
