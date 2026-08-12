import Dexie,{type EntityTable} from 'dexie';
import type { BridgeEvent,Message,RuntimeConfig,Session,UserInput } from '@remote/shared';
export interface Pending {id:string;session_id:string;content:string;input?:UserInput[];runtime?:RuntimeConfig;created_at:string;status:'pending'|'sending'|'failed'|'sent';error?:string}
export interface Meta {key:string;value:string}
export const db=new Dexie('codex-remote') as Dexie&{sessions:EntityTable<Session,'session_id'>;messages:EntityTable<Message,'msg_id'>;events:EntityTable<BridgeEvent,'id'>;pending:EntityTable<Pending,'id'>;meta:EntityTable<Meta,'key'>};
db.version(1).stores({sessions:'session_id,updated_at',messages:'msg_id,session_id,seq',pending:'id,session_id,status'});
db.version(2).stores({sessions:'session_id,updated_at',messages:'msg_id,session_id,seq,client_id',events:'id,session,seq',pending:'id,session_id,status,created_at',meta:'key'});
export async function cacheSessions(items:Session[]){await db.sessions.bulkPut(items)}
export async function cacheMessages(items:Message[]){await db.messages.bulkPut(items)}
export async function cacheEvents(items:BridgeEvent[]){if(items.length)await db.events.bulkPut(items)}
export async function cursor(){return Number((await db.meta.get('cursor'))?.value||0)}
export async function setCursor(value:number){await db.meta.put({key:'cursor',value:String(value)})}
