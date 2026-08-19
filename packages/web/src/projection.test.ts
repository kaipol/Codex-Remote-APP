import { describe,expect,it } from 'vitest';
import type { BridgeEvent } from '@remote/shared';
import { deriveActiveTurn,mergeBridgeEvent,safeEventText,type ProjectedThread } from './composables/eventProjection';
import { truncateDiff } from './composables/diff';
import { dedupeMessages } from './composables/messages';

const event=(type:BridgeEvent['type'],content='',seq=1):BridgeEvent=>({id:`e${seq}`,type,session:'s1',timestamp:`2026-01-01T00:00:0${seq}Z`,seq,content,metadata:{turn_id:'t1'}});
describe('event projection',()=>{
  it('projects and deduplicates user messages',()=>{let state:ProjectedThread={messages:[],events:[],activeTurn:false};const user={...event('user_message','First prompt',1),metadata:{item_id:'u1',client_id:'c1'}};state=mergeBridgeEvent(state,user);state=mergeBridgeEvent(state,user);expect(state.messages).toEqual([expect.objectContaining({msg_id:'u1',role:'user',content:'First prompt'})])});
  it('carries references from user_message metadata',()=>{let state:ProjectedThread={messages:[],events:[],activeTurn:false};const refs=[{type:'file' as const,label:'img.png',path:'C:\\tmp\\img.png',url:'data:image/png;base64,abc'}];const user={...event('user_message','see image',1),metadata:{item_id:'u2',references:refs}};state=mergeBridgeEvent(state,user);expect(state.messages[0].references).toEqual(refs)});
  it('merges assistant deltas and replaces stream with final message',()=>{let state:ProjectedThread={messages:[],events:[],activeTurn:false};state=mergeBridgeEvent(state,event('turn_started','',1));state=mergeBridgeEvent(state,event('assistant_delta','Hel',2));state=mergeBridgeEvent(state,event('assistant_delta','lo',3));expect(state.messages[0].content).toBe('Hello');state=mergeBridgeEvent(state,{...event('assistant_message','Hello',4),metadata:{turn_id:'t1',item_id:'m1'}});expect(state.messages).toEqual([expect.objectContaining({msg_id:'m1',content:'Hello'})]);state=mergeBridgeEvent(state,event('turn_completed','',5));expect(state.activeTurn).toBe(false)});
  it('safely renders unknown metadata',()=>expect(safeEventText({...event('session_updated'),metadata:{nested:'ok'}})).toContain('nested'));
  it('truncates long diffs',()=>{const result=truncateDiff(Array.from({length:30},(_,i)=>`+line ${i}`).join('\n'));expect(result.truncated).toBe(true);expect(result.text.split('\n')).toHaveLength(18)});
  it('replaces an optimistic message with its confirmed server message',()=>{const items=dedupeMessages([{msg_id:'local:c1',client_id:'c1',session_id:'s1',role:'user',content:'same',timestamp:'2026-01-01T00:00:00Z',seq:99},{msg_id:'c1',session_id:'s1',role:'user',content:'same',timestamp:'2026-01-01T00:00:01Z',seq:1}]);expect(items).toHaveLength(1);expect(items[0].msg_id).toBe('c1')});

  it('deduplicates a user message present in both rollout and thread forms',()=>{
    const items=dedupeMessages([
      {msg_id:'s1:1',session_id:'s1',role:'user',content:'same prompt',turn_id:'t1',timestamp:'2026-01-01T00:00:00Z',seq:1},
      {msg_id:'item-1',client_id:'c1',session_id:'s1',role:'user',content:'same prompt',turn_id:'t1',timestamp:'2026-01-01T00:00:01Z',seq:2},
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].msg_id).toBe('item-1');
    expect(items[0].client_id).toBe('c1');
  });
  it('collapses repeated identical user messages that immediately follow each other',()=>{
    const items=dedupeMessages([
      {msg_id:'u1',session_id:'s1',role:'user',content:'继续',turn_id:'t1',timestamp:'2026-01-01T00:00:00Z',seq:1},
      {msg_id:'u2',session_id:'s1',role:'user',content:'继续',turn_id:'t2',timestamp:'2026-01-01T00:00:01Z',seq:2},
      {msg_id:'u3',session_id:'s1',role:'user',content:'继续',turn_id:'t3',timestamp:'2026-01-01T00:00:02Z',seq:3},
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].msg_id).toBe('u1');
  });
  it('keeps identical user messages that are separated by an assistant reply',()=>{
    const items=dedupeMessages([
      {msg_id:'u1',session_id:'s1',role:'user',content:'继续',turn_id:'t1',timestamp:'2026-01-01T00:00:00Z',seq:1},
      {msg_id:'a1',session_id:'s1',role:'assistant',content:'收到',turn_id:'t1',timestamp:'2026-01-01T00:00:01Z',seq:2},
      {msg_id:'u2',session_id:'s1',role:'user',content:'继续',turn_id:'t2',timestamp:'2026-01-01T00:00:02Z',seq:3},
    ]);
    expect(items).toHaveLength(3);
  });
  it('deduplicates replayed assistant responses with different item ids',()=>{const items=dedupeMessages([{msg_id:'a1',turn_id:'t1',session_id:'s1',role:'assistant',content:'same response',timestamp:'2026-01-01T00:00:01Z',seq:1},{msg_id:'a2',turn_id:'t1',session_id:'s1',role:'assistant',content:'same response',timestamp:'2026-01-01T00:00:02Z',seq:2}]);expect(items).toHaveLength(1);expect(items[0].msg_id).toBe('a1')});
  it('prefers the completed assistant item over a duplicate stream item',()=>{const items=dedupeMessages([{msg_id:'stream:t1',turn_id:'t1',session_id:'s1',role:'assistant',content:'same response',timestamp:'2026-01-01T00:00:01Z',seq:1},{msg_id:'a1',turn_id:'t1',session_id:'s1',role:'assistant',content:'same response',timestamp:'2026-01-01T00:00:02Z',seq:2}]);expect(items).toHaveLength(1);expect(items[0].msg_id).toBe('a1')});
  it('does not append a duplicate final assistant event for the same turn',()=>{let state:ProjectedThread={messages:[],events:[],activeTurn:false};const first={...event('assistant_message','same response',1),id:'e1',metadata:{turn_id:'t1',item_id:'a1'}};const replay={...event('assistant_message','same response',2),id:'e2',metadata:{turn_id:'t1',item_id:'a2'}};state=mergeBridgeEvent(state,first);state=mergeBridgeEvent(state,replay);expect(state.messages).toHaveLength(1);expect(state.messages[0].msg_id).toBe('a1')});
  it('deduplicates events on replay (syncAll)',()=>{let state:ProjectedThread={messages:[],events:[],activeTurn:false};const delta1=event('assistant_delta','Hel',2);state=mergeBridgeEvent(state,delta1);state=mergeBridgeEvent(state,delta1);expect(state.messages).toHaveLength(1);expect(state.messages[0].content).toBe('Hel');expect(state.events).toHaveLength(1)});
  it('deduplicates replayed item events with different bridge ids',()=>{let state:ProjectedThread={messages:[],events:[],activeTurn:false};const first={...event('tool_call','ok',1),id:'bridge-1',metadata:{turn_id:'t1',item_id:'tool-1',phase:'completed'}};const replay={...first,id:'bridge-2',seq:2};state=mergeBridgeEvent(state,first);state=mergeBridgeEvent(state,replay);expect(state.events).toHaveLength(1)});
  it('ignores empty user events without references',()=>{let state:ProjectedThread={messages:[],events:[],activeTurn:false};state=mergeBridgeEvent(state,{...event('user_message','',1),metadata:{item_id:'empty-user'}});expect(state.messages).toHaveLength(0);expect(state.events).toHaveLength(0)});
  it('drops warning-only live user events',()=>{let state:ProjectedThread={messages:[],events:[],activeTurn:false};state=mergeBridgeEvent(state,{...event('user_message','⚠Reconnecting... 1/5\n⚠unexpected status 502 Bad Gateway',1),metadata:{item_id:'warning-user'}});expect(state.messages).toHaveLength(0);expect(state.events).toHaveLength(0)});
  it('strips warning lines from live user and assistant messages',()=>{let state:ProjectedThread={messages:[],events:[],activeTurn:false};state=mergeBridgeEvent(state,{...event('user_message','⚠Model metadata missing\nreal request',1),metadata:{item_id:'u1'}});state=mergeBridgeEvent(state,{...event('assistant_message','⚠unexpected status 502\nreal reply',2),metadata:{turn_id:'t1',item_id:'a1'}});expect(state.messages.map(message=>[message.role,message.content])).toEqual([['user','real request'],['assistant','real reply']])});
  it('strips warning lines from live assistant deltas',()=>{let state:ProjectedThread={messages:[],events:[],activeTurn:false};state=mergeBridgeEvent(state,event('assistant_delta','⚠Reconnecting... 1/5\n',1));state=mergeBridgeEvent(state,event('assistant_delta','real ',2));state=mergeBridgeEvent(state,event('assistant_delta','reply',3));expect(state.messages[0].content).toBe('real reply')});
  it('discards late-arriving deltas after final assistant_message',()=>{let state:ProjectedThread={messages:[],events:[],activeTurn:false};state=mergeBridgeEvent(state,event('turn_started','',1));state=mergeBridgeEvent(state,event('assistant_delta','Hel',2));state=mergeBridgeEvent(state,{...event('assistant_message','Hello',3),metadata:{turn_id:'t1',item_id:'m1'}});state=mergeBridgeEvent(state,event('assistant_delta','lo',4));expect(state.messages).toHaveLength(1);expect(state.messages[0].msg_id).toBe('m1');expect(state.messages[0].content).toBe('Hello')});
  it('prefers streamed content when longer than final message',()=>{let state:ProjectedThread={messages:[],events:[],activeTurn:false};state=mergeBridgeEvent(state,event('turn_started','',1));state=mergeBridgeEvent(state,event('assistant_delta','Hello World',2));state=mergeBridgeEvent(state,{...event('assistant_message','Hello',3),metadata:{turn_id:'t1',item_id:'m1'}});expect(state.messages[0].content).toBe('Hello World')});
  it('handles provider_error events in projection',()=>{let state:ProjectedThread={messages:[],events:[],activeTurn:false};state=mergeBridgeEvent(state,event('turn_started','',1));state=mergeBridgeEvent(state,{...event('provider_error','rate limited',2)});expect(state.events).toHaveLength(2);expect(state.activeTurn).toBe(true)});
  it('drops provider errors from runtime warning families',()=>{let state:ProjectedThread={messages:[],events:[],activeTurn:false};for(const content of ['Model metadata for `glm-5.3` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.','unexpected status 502 Bad Gateway: Unknown error, url: http://127.0.0.1:57321/v1/responses','Reconnecting... 5/5'])state=mergeBridgeEvent(state,{...event('provider_error',content,state.events.length+1)});expect(state.events).toHaveLength(0)});
  it('drops system-only user content and deduplicates normalized CRLF copies',()=>{const items=dedupeMessages([
    {msg_id:'error',session_id:'s1',role:'user',content:'<subagent_notification>\n503\n</subagent_notification>',timestamp:'2026-01-01T00:00:00Z',seq:1},
    {msg_id:'u1',session_id:'s1',role:'user',content:'line 1\r\nline 2',turn_id:'t1',timestamp:'2026-01-01T00:00:01Z',seq:2},
    {msg_id:'u2',session_id:'s1',role:'user',content:'line 1\nline 2',turn_id:'t1',timestamp:'2026-01-01T00:00:02Z',seq:3},
  ]);expect(items).toHaveLength(1);expect(items[0].content).toBe('line 1\nline 2')});
  it('restores active turn state for another client joining mid-stream',()=>{expect(deriveActiveTurn([event('turn_started','',1),event('assistant_delta','still working',2)])).toBe(true);expect(deriveActiveTurn([event('turn_started','',1),event('turn_completed','',3)])).toBe(false)});
});
