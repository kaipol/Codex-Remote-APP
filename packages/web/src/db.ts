import Dexie,{type EntityTable} from 'dexie';
import type { BridgeEvent,Message,RuntimeConfig,Session,UserInput } from '@remote/shared';
export interface Pending {id:string;session_id:string;content:string;input?:UserInput[];runtime?:RuntimeConfig;created_at:string;status:'pending'|'waiting'|'sending'|'failed'|'quarantined'|'sent';error?:string}
export interface Meta {key:string;value:string}
export const db=new Dexie('codex-remote') as Dexie&{sessions:EntityTable<Session,'session_id'>;messages:EntityTable<Message,'msg_id'>;events:EntityTable<BridgeEvent,'id'>;pending:EntityTable<Pending,'id'>;meta:EntityTable<Meta,'key'>};
db.version(1).stores({sessions:'session_id,updated_at',messages:'msg_id,session_id,seq',pending:'id,session_id,status'});
db.version(2).stores({sessions:'session_id,updated_at',messages:'msg_id,session_id,seq,client_id',events:'id,session,seq',pending:'id,session_id,status,created_at',meta:'key'});
// Local IndexedDB is a best-effort cache. A broken/stale browser database
// (schema mismatch, quota exhaustion, private-mode restrictions) must never
// block the live send/sync path, so every helper degrades to a warning.
export async function cacheSessions(items:Session[]){try{await db.transaction('rw',db.sessions,async()=>{await db.sessions.clear();if(items.length)await db.sessions.bulkPut(items)})}catch(error){console.warn('[remote:db] sessions cache failed',error)}}
export async function cacheMessages(items:Message[]){try{await db.messages.bulkPut(items)}catch(error){console.warn('[remote:db] messages cache failed',error)}}
export async function cacheEvents(items:BridgeEvent[]){try{if(items.length)await db.events.bulkPut(items)}catch(error){console.warn('[remote:db] events cache failed',error)}}
export async function cursor(){try{return Number((await db.meta.get('cursor'))?.value||0)}catch(error){console.warn('[remote:db] cursor read failed',error);return 0}}
export async function setCursor(value:number){try{await db.meta.put({key:'cursor',value:String(value)})}catch(error){console.warn('[remote:db] cursor write failed',error)}}
export async function streamId(){try{return (await db.meta.get('stream_id'))?.value||''}catch(error){console.warn('[remote:db] stream id read failed',error);return ''}}
export async function setStreamId(value:string){try{if(value)await db.meta.put({key:'stream_id',value})}catch(error){console.warn('[remote:db] stream id write failed',error)}}
export async function clearLocalState(){
  try{
    await db.transaction('rw',db.sessions,db.messages,db.events,db.pending,db.meta,async()=>{
      await Promise.all([db.sessions.clear(),db.messages.clear(),db.events.clear(),db.pending.clear(),db.meta.clear()]);
    });
  }catch(error){console.warn('[remote:db] local state clear failed',error)}
}
