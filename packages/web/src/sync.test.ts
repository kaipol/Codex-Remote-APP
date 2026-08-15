import {describe,expect,it} from 'vitest';
import type {BridgeEvent,SyncResponse} from '@remote/shared';
import {drainSync} from './composables/sync';

const event=(seq:number):BridgeEvent=>({id:`e${seq}`,type:'assistant_delta',session:'s1',timestamp:new Date(seq).toISOString(),seq,content:String(seq)});

describe('sync pagination',()=>{
  it('drains full pages until the server returns a short page',async()=>{
    const pages:SyncResponse[]=[{cursor:1000,events:Array.from({length:1000},(_,index)=>event(index+1))},{cursor:1001,events:[event(1001)]}];
    const applied:number[]=[];
    const cursor=await drainSync(0,async()=>pages.shift()!,async value=>{applied.push(value.seq)});
    expect(cursor).toBe(1001);
    expect(applied).toHaveLength(1001);
  });

  it('clears stale client state when its cursor is ahead of a reset server',async()=>{
    let resets=0;const applied:number[]=[];
    const cursor=await drainSync(99,async()=>({cursor:2,events:[event(1),event(2)],reset:true}),async value=>{applied.push(value.seq)},async()=>{resets++});
    expect(cursor).toBe(2);
    expect(resets).toBe(1);
    expect(applied).toEqual([1,2]);
  });

  it('continues when an authorization-filtered page contains fewer than 1000 visible events',async()=>{
    const pages:SyncResponse[]=[{cursor:1000,events:[event(999)],has_more:true},{cursor:1001,events:[event(1001)],has_more:false}];
    const applied:number[]=[];
    const cursor=await drainSync(0,async()=>pages.shift()!,async value=>{applied.push(value.seq)});
    expect(cursor).toBe(1001);
    expect(applied).toEqual([999,1001]);
  });
});
