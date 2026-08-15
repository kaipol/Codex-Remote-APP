import type { BridgeEvent, SyncResponse } from '@remote/shared';

const PAGE_SIZE=1000;

export async function drainSync(
  initialCursor:number,
	 fetchPage:(cursor:number)=>Promise<SyncResponse>,
	 apply:(event:BridgeEvent)=>Promise<void>,
	 reset:()=>Promise<void>=async()=>{},
):Promise<number>{
	 let current=initialCursor;
	 let resetApplied=false;
	 while(true){
	   const page=await fetchPage(current);
	   if(page.reset){if(resetApplied)throw new Error('sync reset repeated');await reset();current=0;resetApplied=true}
	   for(const event of page.events)await apply(event);
    const next=Math.max(current,page.cursor,...page.events.map(event=>event.seq));
    const hasMore=page.has_more??page.events.length>=PAGE_SIZE;
    if(!hasMore)return next;
    if(next<=current)throw new Error('sync cursor did not advance');
    current=next;
  }
}
