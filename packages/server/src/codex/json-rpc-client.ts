import { EventEmitter } from 'node:events';
import { AppServerProcess } from './app-server-process.js';
import type { RpcId, RpcResponse } from './protocol.js';

export class RpcUnavailableError extends Error { status=503 }
export class RpcTimeoutError extends Error { status=504 }
export class RpcRemoteError extends Error { constructor(message:string,readonly code?:number,readonly data?:unknown){super(message)} }
interface Pending { resolve:(v:unknown)=>void; reject:(e:unknown)=>void; timer:NodeJS.Timeout; abort?:()=>void }
export class JsonRpcClient extends EventEmitter {
 private next=1;private pending=new Map<RpcId,Pending>();private started=false;
 constructor(readonly process:AppServerProcess,private timeoutMs=30000){super();process.on('line',(line:string)=>this.line(line));process.on('stderr',(line:string)=>this.emit('stderr',line));process.on('failure',(e:Error)=>this.fail(new RpcUnavailableError(e.message)));process.on('exit',(code:number|null)=>this.fail(new RpcUnavailableError(`Codex app-server exited (${code??'signal'})`)))}
 start(){if(!this.started){this.started=true;this.process.start()}}
 notify(method:string,params?:unknown){this.start();this.process.write(params===undefined?{method}:{method,params})}
 respond(id:RpcId,result:unknown){if(!this.started)throw new RpcUnavailableError('Codex app-server is not running');this.process.write({id,result})}
 request<T=unknown>(method:string,params:unknown={},options:{timeoutMs?:number;signal?:AbortSignal}={}):Promise<T>{this.start();const id=this.next++;return new Promise<T>((resolve,reject)=>{const done=()=>{const p=this.pending.get(id);if(p){clearTimeout(p.timer);p.abort?.();this.pending.delete(id)}};const timer=setTimeout(()=>{done();reject(new RpcTimeoutError(`${method} timed out`))},options.timeoutMs??this.timeoutMs);const abort=options.signal?()=>{done();reject(options.signal!.reason??new Error('aborted'))}:undefined;if(options.signal?.aborted){clearTimeout(timer);return reject(options.signal.reason??new Error('aborted'))}options.signal?.addEventListener('abort',abort!,{once:true});this.pending.set(id,{resolve:v=>{done();resolve(v as T)},reject:e=>{done();reject(e)},timer,abort:abort?()=>options.signal!.removeEventListener('abort',abort):undefined});try{this.process.write({id,method,params})}catch(e){done();reject(new RpcUnavailableError((e as Error).message))}})}
 private line(line:string){let value:any;try{value=JSON.parse(line)}catch{this.emit('malformed',line);return}if(value && value.id!==undefined && ('result'in value||'error'in value) && !value.method){const p=this.pending.get(value.id);if(!p)return;const response=value as RpcResponse;response.error?p.reject(new RpcRemoteError(response.error.message,response.error.code,response.error.data)):p.resolve(response.result);return}if(value && typeof value.method==='string'){value.id!==undefined?this.emit('serverRequest',value):this.emit('notification',value);return}this.emit('malformed',line)}
 private fail(error:Error){this.started=false;for(const p of this.pending.values()){clearTimeout(p.timer);p.abort?.();p.reject(error)}this.pending.clear();this.emit('unavailable',error)}
 async close(){this.fail(new RpcUnavailableError('Codex app-server stopped'));await this.process.stop()}
}
