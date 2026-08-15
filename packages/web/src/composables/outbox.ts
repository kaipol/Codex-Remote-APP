import type { Pending } from '../db';
export type SendPending=(item:Pending)=>Promise<unknown>;
export class DeferredSendError extends Error {
  constructor(message='等待远端会话完成当前回复') {
    super(message);
    this.name='DeferredSendError';
  }
}
export async function replayInSessionOrder(items:Pending[], send:SendPending, mark:(item:Pending)=>Promise<void>){
  // Filter out items that are already sent — they can linger in the DB
  // if a previous replay cycle was interrupted mid-way.
  const pending=items.filter(item=>item.status!=='sent');
  if(!pending.length)return pending;
  const ordered=[...pending].sort((a,b)=>a.session_id.localeCompare(b.session_id)||a.created_at.localeCompare(b.created_at));
  const blocked=new Set<string>();
  for(const item of ordered){
    if(blocked.has(item.session_id))continue;
    try{
      item.status='sending';item.error=undefined;await mark(item);
      await send(item);
      item.status='sent';await mark(item);
    }catch(error){
      if(error instanceof DeferredSendError){
        item.status='waiting';item.error=undefined;await mark(item);
      }else{
        item.status='failed';item.error=error instanceof Error?error.message:'发送失败';await mark(item);
      }
      // Block subsequent items for this session so we don't send messages out of order.
      blocked.add(item.session_id);
    }
  }
  return ordered;
}
