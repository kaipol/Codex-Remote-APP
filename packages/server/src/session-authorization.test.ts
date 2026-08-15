import {afterEach,describe,expect,it} from 'vitest';
import {mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadConfig} from './config.js';
import {Store} from './db.js';
import {SessionService} from './service.js';

let root='';let outside='';let store:Store|undefined;let sessions:SessionService|undefined;
afterEach(async()=>{await sessions?.manager.close();store?.close();if(root)await rm(root,{recursive:true,force:true});if(outside)await rm(outside,{recursive:true,force:true})});

async function rollout(base:string,id:string,cwd:string){const dir=join(base,'sessions','2026','08','15');await mkdir(dir,{recursive:true});await writeFile(join(dir,`rollout-${id}.jsonl`),JSON.stringify({timestamp:'2026-08-15T00:00:00Z',type:'session_meta',payload:{id,cwd,timestamp:'2026-08-15T00:00:00Z'}})+'\n')}

describe('session authorization',()=>{
  it('hides and rejects sessions outside the canonical cwd allowlist',async()=>{
    root=join(tmpdir(),`codex-authz-${crypto.randomUUID()}`);outside=join(tmpdir(),`codex-authz-outside-${crypto.randomUUID()}`);
    const inside=join(root,'workspace');await Promise.all([mkdir(inside,{recursive:true}),mkdir(outside,{recursive:true})]);
    const insideId='11111111-1111-4111-8111-111111111111',outsideId='22222222-2222-4222-8222-222222222222';
    await Promise.all([rollout(root,insideId,inside),rollout(root,outsideId,outside)]);
    const config=loadConfig({databasePath:':memory:',secret:'x'.repeat(32),codexHome:root,codexSessionsDir:join(root,'sessions'),codexCommand:join(root,'missing-codex.exe'),codexCwdAllowlist:[inside],codexRequestTimeoutMs:50});
    store=new Store(':memory:');sessions=new SessionService(store,config);
    await expect(sessions.list()).resolves.toEqual([expect.objectContaining({session_id:insideId,cwd:inside})]);
    await expect(sessions.detail(outsideId)).resolves.toBeUndefined();
    await expect(sessions.message(outsideId,[{type:'text',text:'blocked'}])).rejects.toMatchObject({status:404});
    const ghostId='33333333-3333-4333-8333-333333333333';
    store.ensureEventSession(insideId);store.ensureEventSession(outsideId);store.ensureEventSession(ghostId);
    store.addEvent({id:'inside-event',type:'assistant_delta',session:insideId,timestamp:'2026-08-15T00:00:01Z',content:'allowed'});
    store.addEvent({id:'outside-event',type:'assistant_delta',session:outsideId,timestamp:'2026-08-15T00:00:02Z',content:'blocked'});
    store.addEvent({id:'ghost-event',type:'assistant_delta',session:ghostId,timestamp:'2026-08-15T00:00:03Z',content:'spoofed',metadata:{cwd:inside}});
    await expect(sessions.sync(0)).resolves.toMatchObject({cursor:3,events:[expect.objectContaining({id:'inside-event'})],has_more:false});
    store.addApproval({requestId:'outside-approval',rawId:1,epoch:1,threadId:outsideId,turnId:'turn',itemId:'item',kind:'item/commandExecution/requestApproval',payload:{}});
    await expect(sessions.approvals(outsideId)).rejects.toMatchObject({status:404});
    await rollout(root,insideId,outside);
    await expect(sessions.message(insideId,[{type:'text',text:'moved outside'}])).rejects.toMatchObject({status:404});
  });
});
