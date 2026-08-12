import type { BridgeEvent, Message } from '@remote/shared';

export interface ProjectedThread { messages: Message[]; events: BridgeEvent[]; activeTurn: boolean }

export function mergeBridgeEvent(state: ProjectedThread, event: BridgeEvent): ProjectedThread {
  if(event.type==='user_message'){
    const clientId=typeof event.metadata?.client_id==='string'?event.metadata.client_id:undefined;
    const turnId=typeof event.metadata?.turn_id==='string'?event.metadata.turn_id:undefined;
    const message:Message={msg_id:String(event.metadata?.item_id||event.id),...(clientId?{client_id:clientId}:{}),...(turnId?{turn_id:turnId}:{}),session_id:event.session,role:'user',content:event.content||'',timestamp:event.timestamp,seq:event.seq};
    const index=state.messages.findIndex(item=>item.msg_id===message.msg_id||Boolean(clientId&&item.client_id===clientId)||item.msg_id===`local:${clientId}`);
    if(index<0)return {...state,messages:[...state.messages,message]};
    const messages=[...state.messages];messages[index]={...messages[index],...message};return {...state,messages};
  }
  if (event.type === 'assistant_delta') {
    const messages = [...state.messages];
    const key = String(event.metadata?.turn_id || 'stream');
    const index = messages.findIndex(message => message.msg_id === `stream:${key}`);
    if (index >= 0) messages[index] = { ...messages[index], content: messages[index].content + (event.content || '') };
    else messages.push({ msg_id:`stream:${key}`, turn_id:key, session_id:event.session, role:'assistant', content:event.content || '', timestamp:event.timestamp, seq:event.seq });
    return { ...state, messages };
  }
  if (event.type === 'assistant_message') {
    const key = String(event.metadata?.turn_id || 'stream');
    const streamId = `stream:${key}`;
    const finalMessage:Message = { msg_id:String(event.metadata?.item_id || event.id), turn_id:key, session_id:event.session, role:'assistant', content:event.content || '', timestamp:event.timestamp, seq:event.seq };
    const index = state.messages.findIndex(message => message.msg_id === streamId);
    const messages = [...state.messages];
    if (index >= 0) messages.splice(index, 1, finalMessage); else if (!messages.some(message => message.msg_id === finalMessage.msg_id)) messages.push(finalMessage);
    return { ...state, messages, activeTurn:state.activeTurn };
  }
  const activeTurn = event.type === 'turn_started' ? true : event.type === 'turn_completed' || event.type === 'turn_failed' ? false : state.activeTurn;
  const events = state.events.some(item => item.id === event.id) ? state.events : [...state.events, event];
  return { ...state, events, activeTurn };
}

export function safeEventText(event: BridgeEvent): string {
  if (event.content) return event.content;
  try { return JSON.stringify(event.metadata || {}, null, 2); } catch { return '无法显示事件详情'; }
}
