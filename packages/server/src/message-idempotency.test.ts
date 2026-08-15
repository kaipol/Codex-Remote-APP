import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadConfig} from './config.js';
import {Store} from './db.js';
import {SessionService} from './service.js';
import type {CodexManager} from './codex/manager.js';
import {RpcTimeoutError} from './codex/json-rpc-client.js';

const sessionId='11111111-1111-4111-8111-111111111111';
let root='';let store:Store;

beforeEach(async()=>{root=join(tmpdir(),`codex-idempotency-${crypto.randomUUID()}`);await mkdir(root,{recursive:true});store=new Store(':memory:')});
afterEach(async()=>{store.close();await rm(root,{recursive:true,force:true})});

function service(manager:Partial<CodexManager>){const config=loadConfig({databasePath:':memory:',secret:'x'.repeat(32),codexHome:root,codexSessionsDir:join(root,'sessions'),codexCwdAllowlist:[root],codexRequestTimeoutMs:50});return new SessionService(store,config,manager as CodexManager)}
function thread(turns:any[]=[]){return {id:sessionId,cwd:root,createdAt:1,updatedAt:1,turns}}

describe('message idempotency',()=>{
  it('resolves an ambiguous timeout from the persisted user event instead of starting a duplicate turn',async()=>{
    const startTurn=vi.fn().mockRejectedValue(new RpcTimeoutError('turn/start timed out'));
    const sessions=service({read:vi.fn(async()=>thread()),startTurn} as Partial<CodexManager>);
    await expect(sessions.message(sessionId,[{type:'text',text:'hello'}],{},'client-1')).rejects.toBeInstanceOf(RpcTimeoutError);
    store.ensureEventSession(sessionId);
    store.addEvent({id:'user-1',type:'user_message',session:sessionId,timestamp:new Date().toISOString(),content:'hello',metadata:{client_id:'client-1',turn_id:'turn-1'}});
    await expect(sessions.message(sessionId,[{type:'text',text:'hello'}],{},'client-1')).resolves.toEqual({thread_id:sessionId,turn_id:'turn-1',status:'started'});
    expect(startTurn).toHaveBeenCalledTimes(1);
  });

  it('releases a deterministic busy rejection so a queued message can retry after the active turn',async()=>{
    const startTurn=vi.fn().mockRejectedValueOnce(Object.assign(new Error('thread already has an active turn'),{status:409})).mockResolvedValueOnce({thread_id:sessionId,turn_id:'turn-2',status:'started'});
    const sessions=service({read:vi.fn(async()=>thread()),startTurn} as Partial<CodexManager>);
    await expect(sessions.message(sessionId,[{type:'text',text:'queued'}],{},'client-2')).rejects.toMatchObject({status:409});
    await expect(sessions.message(sessionId,[{type:'text',text:'queued'}],{},'client-2')).resolves.toMatchObject({turn_id:'turn-2'});
    expect(startTurn).toHaveBeenCalledTimes(2);
  });

  it('does not resend an unresolved timeout after the uncertainty window',async()=>{
    const startTurn=vi.fn().mockRejectedValue(new RpcTimeoutError('turn/start timed out'));
    const sessions=service({read:vi.fn(async()=>thread()),startTurn} as Partial<CodexManager>);
    await expect(sessions.message(sessionId,[{type:'text',text:'still running'}],{},'client-3')).rejects.toBeInstanceOf(RpcTimeoutError);
    await expect(sessions.message(sessionId,[{type:'text',text:'still running'}],{},'client-3')).rejects.toMatchObject({status:409});
    expect(startTurn).toHaveBeenCalledTimes(1);
  });
});
