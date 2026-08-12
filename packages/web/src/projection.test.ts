import { describe,expect,it } from 'vitest';
import type { BridgeEvent } from '@remote/shared';
import { mergeBridgeEvent,safeEventText,type ProjectedThread } from './composables/eventProjection';
import { truncateDiff } from './composables/diff';
import { dedupeMessages } from './composables/messages';

const event=(type:BridgeEvent['type'],content='',seq=1):BridgeEvent=>({id:`e${seq}`,type,session:'s1',timestamp:`2026-01-01T00:00:0${seq}Z`,seq,content,metadata:{turn_id:'t1'}});
describe('event projection',()=>{
  it('projects and deduplicates user messages',()=>{let state:ProjectedThread={messages:[],events:[],activeTurn:false};const user={...event('user_message','First prompt',1),metadata:{item_id:'u1',client_id:'c1'}};state=mergeBridgeEvent(state,user);state=mergeBridgeEvent(state,user);expect(state.messages).toEqual([expect.objectContaining({msg_id:'u1',role:'user',content:'First prompt'})])});
  it('merges assistant deltas and replaces stream with final message',()=>{let state:ProjectedThread={messages:[],events:[],activeTurn:false};state=mergeBridgeEvent(state,event('turn_started','',1));state=mergeBridgeEvent(state,event('assistant_delta','Hel',2));state=mergeBridgeEvent(state,event('assistant_delta','lo',3));expect(state.messages[0].content).toBe('Hello');state=mergeBridgeEvent(state,{...event('assistant_message','Hello',4),metadata:{turn_id:'t1',item_id:'m1'}});expect(state.messages).toEqual([expect.objectContaining({msg_id:'m1',content:'Hello'})]);state=mergeBridgeEvent(state,event('turn_completed','',5));expect(state.activeTurn).toBe(false)});
  it('safely renders unknown metadata',()=>expect(safeEventText({...event('session_updated'),metadata:{nested:'ok'}})).toContain('nested'));
  it('truncates long diffs',()=>{const result=truncateDiff(Array.from({length:30},(_,i)=>`+line ${i}`).join('\n'));expect(result.truncated).toBe(true);expect(result.text.split('\n')).toHaveLength(18)});
  it('replaces an optimistic message with its confirmed server message',()=>{const items=dedupeMessages([{msg_id:'local:c1',client_id:'c1',session_id:'s1',role:'user',content:'same',timestamp:'2026-01-01T00:00:00Z',seq:99},{msg_id:'c1',session_id:'s1',role:'user',content:'same',timestamp:'2026-01-01T00:00:01Z',seq:1}]);expect(items).toHaveLength(1);expect(items[0].msg_id).toBe('c1')});
});
