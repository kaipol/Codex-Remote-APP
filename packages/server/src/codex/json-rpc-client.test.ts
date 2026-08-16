import { EventEmitter } from 'node:events';
import { describe,expect,it } from 'vitest';
import { JsonRpcClient,RpcRemoteError,RpcTimeoutError,RpcUnavailableError } from './json-rpc-client.js';

class FakeProcess extends EventEmitter {
  writes:any[]=[];
  start(){}
  write(value:unknown){this.writes.push(value)}
  async stop(){}
}

describe('JsonRpcClient reliability',()=>{
  it('isolates malformed lines and still resolves the pending request',async()=>{
    const process=new FakeProcess();const rpc=new JsonRpcClient(process as any,100);
    const malformed:string[]=[];rpc.on('malformed',line=>malformed.push(line));
    const pending=rpc.request('thread/list');const id=process.writes[0].id;
    process.emit('line','{not-json');process.emit('line',JSON.stringify({id,result:{data:[]}}));
    await expect(pending).resolves.toEqual({data:[]});expect(malformed).toEqual(['{not-json']);
  });
  it('rejects pending requests when the process exits',async()=>{
    const process=new FakeProcess();const rpc=new JsonRpcClient(process as any,1000);
    const pending=rpc.request('thread/read');process.emit('exit',9);
    await expect(pending).rejects.toBeInstanceOf(RpcUnavailableError);
  });
  it('times out unanswered requests',async()=>{
    const process=new FakeProcess();const rpc=new JsonRpcClient(process as any,10);
    await expect(rpc.request('thread/read')).rejects.toBeInstanceOf(RpcTimeoutError);
  });
  it('maps active-writer failures to a conflict response',async()=>{
    const process=new FakeProcess();const rpc=new JsonRpcClient(process as any,100);
    const pending=rpc.request('thread/resume');const id=process.writes[0].id;
    process.emit('line',JSON.stringify({id,error:{code:-32603,message:'thread thread-1 already has an active writer'}}));
    await expect(pending).rejects.toMatchObject({name:'RpcRemoteError',status:409});
    await expect(pending).rejects.toBeInstanceOf(RpcRemoteError);
  });
});
