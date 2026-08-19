import type { Message,MessageReference } from '@remote/shared';
import type { Pending } from '../db';
export type SendPending=(item:Pending)=>Promise<unknown>;
export class DeferredSendError extends Error {
  constructor(message='等待远端会话完成当前回复') {
    super(message);
    this.name='DeferredSendError';
  }
}
export function isPendingCancellable(item:Pending){
  return item.status!=='sending'&&item.status!=='sent';
}

function pendingReferences(item:Pending):MessageReference[]{
  const references:MessageReference[]=[];
  for(const input of item.input??[]){
    if(input.type==='mention')references.push({type:'file',label:input.name,path:input.path});
    else if(input.type==='image')references.push({type:'file',label:input.name||'图片',url:input.url});
    else if(input.type==='skill')references.push({type:'skill',label:input.name,path:input.path});
  }
  return references;
}

export function pendingToMessage(item:Pending,sequence=0):Message{
  const references=pendingReferences(item);
  return {
    msg_id:`local:${item.id}`,
    client_id:item.id,
    session_id:item.session_id,
    role:'user',
    content:item.content,
    timestamp:item.created_at,
    seq:Number.MAX_SAFE_INTEGER-sequence,
    ...(references.length?{references}:{}),
  };
}

export function mergePendingMessages(messages:Message[],items:Pending[],sessionId:string):Message[]{
  const result=[...messages];
  const queued=items.filter(item=>item.session_id===sessionId).sort((a,b)=>a.created_at.localeCompare(b.created_at));
  for(const item of queued){
    const known=result.some(message=>message.client_id===item.id||message.msg_id===`local:${item.id}`);
    if(!known)result.push(pendingToMessage(item,result.length));
  }
  return result.sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.seq-b.seq);
}

export async function replayInSessionOrder(items:Pending[], send:SendPending, mark:(item:Pending)=>Promise<void>, isCancelled:(item:Pending)=>boolean=()=>false){
  // Filter out items that are already sent — they can linger in the DB
  // if a previous replay cycle was interrupted mid-way.
  const pending=items.filter(item=>item.status!=='sent');
  if(!pending.length)return pending;
  const ordered=[...pending].sort((a,b)=>a.session_id.localeCompare(b.session_id)||a.created_at.localeCompare(b.created_at));
  const blocked=new Set<string>();
  for(const item of ordered){
    if(blocked.has(item.session_id)||isCancelled(item))continue;
    try{
      item.status='sending';item.error=undefined;await mark(item);
      if(isCancelled(item))continue;
      await send(item);
      if(isCancelled(item))continue;
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
