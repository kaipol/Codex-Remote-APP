import type { Pending } from '../db';
export type SendPending=(item:Pending)=>Promise<unknown>;
export async function replayInSessionOrder(items:Pending[], send:SendPending, mark:(item:Pending)=>Promise<void>){
  const ordered=[...items].sort((a,b)=>a.session_id.localeCompare(b.session_id)||a.created_at.localeCompare(b.created_at));
  const blocked=new Set<string>();
  for(const item of ordered){
    if(blocked.has(item.session_id))continue;
    try{item.status='sending';item.error=undefined;await mark(item);await send(item);item.status='sent';await mark(item)}
    catch(error){item.status='failed';item.error=error instanceof Error?error.message:'发送失败';await mark(item);blocked.add(item.session_id)}
  }
  return ordered;
}
