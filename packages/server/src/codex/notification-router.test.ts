import { describe, expect, it } from 'vitest';
import { routeNotification } from './notification-router.js';

describe('notification routing', () => {
  it('projects a newly started thread as a session update', () => {
    const event = routeNotification('thread/started', {
      thread: { id: 'thread-1', cwd: 'C:\\workspace', name: 'New conversation' },
    });

    expect(event).toMatchObject({
      type: 'session_updated',
      session: 'thread-1',
      metadata: { status: 'started', cwd: 'C:\\workspace', title: 'New conversation' },
    });
  });

	  it('waits for completed message items before projecting final text',()=>{
	    expect(routeNotification('item/started',{threadId:'thread-1',turnId:'turn-1',item:{id:'message-1',type:'agentMessage',text:''}})).toBeUndefined();
	    const event=routeNotification('item/completed',{threadId:'thread-1',turnId:'turn-1',item:{id:'message-1',type:'agentMessage',text:'done'}});
	    expect(event).toMatchObject({type:'assistant_message',content:'done',metadata:{phase:'completed'}});
	    expect(event).not.toHaveProperty('raw');
	  });

	  it('keeps structured reasoning summary text in live events',()=>{
	    const event=routeNotification('item/completed',{threadId:'thread-1',turnId:'turn-1',item:{id:'reasoning-1',type:'reasoning',summary:[{type:'summary_text',text:'检查历史内容'}]}});
	    expect(event).toMatchObject({type:'reasoning_status',content:'检查历史内容'});
	  });
});
