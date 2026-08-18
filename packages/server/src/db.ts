import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BridgeEvent, SessionStatus } from '@remote/shared';

export class Store {
 readonly db:Database.Database;
 private readonly _streamId:string;
 get streamId(){return this._streamId}
 constructor(path:string){if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});this.db=new Database(path);this.db.pragma('foreign_keys=ON');this.db.pragma('journal_mode=WAL');this.migrate();this._streamId=this.loadStreamId()}
 private migrate(){this.db.exec(`
 CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,client_id TEXT UNIQUE,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,seq INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,type TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,refresh_hash TEXT NOT NULL,created_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,revoked_at TEXT);
 CREATE TABLE IF NOT EXISTS pair_codes(code_hash TEXT PRIMARY KEY,expires_at TEXT NOT NULL,used_at TEXT);
 CREATE TABLE IF NOT EXISTS session_overlays(session_id TEXT PRIMARY KEY,title TEXT,status TEXT,pinned INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
 ${approvalTableSql()}
 CREATE TABLE IF NOT EXISTS idempotency(session_id TEXT NOT NULL,client_id TEXT NOT NULL,response TEXT,status TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(session_id,client_id));
 CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 `);this.migrateLegacyApprovals();this.addColumn('approvals','turn_id','TEXT');this.addColumn('approvals','item_id','TEXT');this.addColumn('approvals','updated_at',"TEXT NOT NULL DEFAULT ''");this.addColumn('approvals','raw_id',"TEXT NOT NULL DEFAULT '\"\"'");this.addColumn('approvals','epoch','INTEGER NOT NULL DEFAULT 0');this.addColumn('approvals','decision','TEXT');this.addColumn('devices','persistent','INTEGER NOT NULL DEFAULT 0');this.db.prepare("UPDATE approvals SET updated_at=created_at WHERE updated_at='' OR updated_at IS NULL").run();this.markPendingIdempotencyUncertain()}
 private loadStreamId(){const existing=this.db.prepare("SELECT value FROM metadata WHERE key='stream_id'").get() as {value?:string}|undefined;if(existing?.value)return existing.value;const value=randomUUID();this.db.prepare("INSERT INTO metadata(key,value) VALUES('stream_id',?)").run(value);return value}
 private addColumn(table:string,column:string,definition:string){const exists=(this.db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name=?`).get(table,column));if(!exists)this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)}
 private migrateLegacyApprovals(){const columns=new Set((this.db.prepare('PRAGMA table_info(approvals)').all() as Array<{name:string}>).map(column=>column.name));if(columns.has('request_id'))return;if(!columns.has('id'))throw new Error('unsupported approvals table schema');const kind=columns.has('type')?'type':"'unknown'";const resolved=columns.has('resolved_at')?'resolved_at':'NULL';const epoch=columns.has('epoch')?'epoch':'0';const decision=columns.has('decision')?'decision':'NULL';this.db.transaction(()=>{this.db.exec('ALTER TABLE approvals RENAME TO approvals_legacy_migration');this.db.exec(approvalTableSql());this.db.exec(`INSERT INTO approvals(request_id,session_id,turn_id,item_id,kind,payload,status,created_at,updated_at,raw_id,epoch,decision) SELECT id,session_id,NULL,NULL,${kind},payload,status,created_at,COALESCE(${resolved},created_at),'',${epoch},${decision} FROM approvals_legacy_migration`);this.db.exec('DROP TABLE approvals_legacy_migration')})()}
 ensureSession(thread:{id:string;preview?:string;name?:string|null;cwd:string;createdAt:number;updatedAt:number}){this.db.prepare(`INSERT INTO sessions(id,title,model,status,created_at,updated_at) VALUES(?,?,?,'active',?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,updated_at=excluded.updated_at`).run(thread.id,thread.name||thread.preview||`Codex ${thread.id}`,'codex',new Date(thread.createdAt*1000).toISOString(),new Date(thread.updatedAt*1000).toISOString())}
 ensureEventSession(id:string){const now=new Date().toISOString();this.db.prepare("INSERT OR IGNORE INTO sessions(id,title,model,status,created_at,updated_at) VALUES(?,?,'codex','active',?,?)").run(id,`Codex ${id}`,now,now)}
 addApproval(a:{requestId:string;rawId:string|number;epoch:number;threadId:string;turnId:string;itemId:string;kind:string;payload:unknown}){const now=new Date().toISOString();this.db.prepare('INSERT OR IGNORE INTO approvals(request_id,session_id,turn_id,item_id,kind,payload,status,created_at,updated_at,raw_id,epoch,decision) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)').run(a.requestId,a.threadId,a.turnId||null,a.itemId||null,a.kind,JSON.stringify(a.payload),'pending',now,now,JSON.stringify(a.rawId),a.epoch)}
 getApproval(id:string){const row=this.db.prepare('SELECT * FROM approvals WHERE request_id=?').get(id) as any;return row?approvalRow(row):undefined}
 /** Marks an approval resolved only if it is still pending, so concurrent decisions cannot double-respond. */
 settleApproval(id:string,decision:string){return this.db.prepare("UPDATE approvals SET status='resolved',decision=?,updated_at=? WHERE request_id=? AND status='pending'").run(decision,new Date().toISOString(),id).changes>0}
 revertApproval(id:string){this.db.prepare("UPDATE approvals SET status='pending',decision=NULL,updated_at=? WHERE request_id=?").run(new Date().toISOString(),id)}
 /** App-server restarts drop in-flight server requests; older epochs can never be answered. */
 expireApprovalsBefore(epoch:number){return this.db.prepare("UPDATE approvals SET status='stale',updated_at=? WHERE status='pending' AND epoch<?").run(new Date().toISOString(),epoch).changes}
 listApprovals(sessionId?:string){const rows=(sessionId?this.db.prepare("SELECT * FROM approvals WHERE status='pending' AND session_id=? ORDER BY created_at").all(sessionId):this.db.prepare("SELECT * FROM approvals WHERE status='pending' ORDER BY created_at").all()) as any[];return rows.map(approvalRow)}
	 getIdempotent(session:string,client:string){const row=this.db.prepare('SELECT response,status,created_at FROM idempotency WHERE session_id=? AND client_id=?').get(session,client) as any;return row?{response:row.response?JSON.parse(row.response):undefined,status:row.status,created_at:String(row.created_at)}:undefined}
		 findAcceptedTurn(session:string,client:string){const rows=this.db.prepare("SELECT payload FROM events WHERE session_id=? AND type='user_message' ORDER BY seq DESC LIMIT 200").all(session) as Array<{payload:string}>;for(const row of rows){try{const event=JSON.parse(row.payload);if(event.metadata?.client_id===client&&typeof event.metadata?.turn_id==='string')return {thread_id:session,turn_id:event.metadata.turn_id,status:'started' as const}}catch{/* isolate malformed historical rows */}}return undefined}
	 remoteSessionIds(){return (this.db.prepare('SELECT DISTINCT session_id FROM idempotency').all() as Array<{session_id:string}>).map(row=>row.session_id)}
	 beginIdempotent(session:string,client:string){try{this.db.prepare("INSERT INTO idempotency VALUES(?,?,NULL,'pending',?)").run(session,client,new Date().toISOString());return true}catch{return false}}
 finishIdempotent(session:string,client:string,response:unknown){this.db.prepare("UPDATE idempotency SET response=?,status='done' WHERE session_id=? AND client_id=?").run(JSON.stringify(response),session,client)}
 /** A pending turn may have reached Codex before the bridge disappeared; retain it
  * so retries can reconcile by client_id instead of creating a duplicate turn. */
 markPendingIdempotencyUncertain(){return this.db.prepare("UPDATE idempotency SET status='uncertain' WHERE status='pending'").run().changes}
	 failIdempotent(session:string,client:string){this.db.prepare('DELETE FROM idempotency WHERE session_id=? AND client_id=?').run(session,client)}
 getOverlay(id:string){return this.db.prepare('SELECT * FROM session_overlays WHERE session_id=?').get(id) as {session_id:string;title:string|null;status:SessionStatus|null;pinned:number;updated_at:string}|undefined}
 listOverlays(){return this.db.prepare('SELECT * FROM session_overlays').all() as Array<{session_id:string;title:string|null;status:SessionStatus|null;pinned:number;updated_at:string}>}
 updateOverlay(id:string,changes:{title?:string;status?:SessionStatus;pinned?:boolean}){const old=this.getOverlay(id);const now=new Date().toISOString();this.db.prepare(`INSERT INTO session_overlays(session_id,title,status,pinned,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET title=excluded.title,status=excluded.status,pinned=excluded.pinned,updated_at=excluded.updated_at`).run(id,changes.title??old?.title??null,changes.status??old?.status??null,changes.pinned===undefined?(old?.pinned??0):Number(changes.pinned),now);return this.getOverlay(id)}
 deleteOverlay(id:string){return this.db.prepare('DELETE FROM session_overlays WHERE session_id=?').run(id).changes>0}
 addEvent(e:Omit<BridgeEvent,'seq'>):BridgeEvent{const payload=JSON.stringify(e);const info=this.db.prepare('INSERT INTO events(id,session_id,type,payload,created_at) VALUES(?,?,?,?,?)').run(e.id,e.session,e.type,payload,e.timestamp);return {...e,seq:Number(info.lastInsertRowid)}}
	 eventsAfter(cursor:number){return (this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 1000').all(cursor) as any[]).map(rowEvent)}
	 eventsForSession(sessionId:string){return (this.db.prepare('SELECT * FROM events WHERE session_id=? ORDER BY seq').all(sessionId) as any[]).map(rowEvent)}
	 latestCursor(){return Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get() as {seq:number}).seq)}
 savePair(hash:string,expires:string){this.db.prepare('DELETE FROM pair_codes');this.db.prepare('INSERT INTO pair_codes VALUES(?,?,NULL)').run(hash,expires)}
 consumePair(hash:string){const row=this.db.prepare("SELECT * FROM pair_codes WHERE code_hash=? AND used_at IS NULL AND expires_at>?").get(hash,new Date().toISOString()) as any;if(!row)return false;this.db.prepare('UPDATE pair_codes SET used_at=? WHERE code_hash=?').run(new Date().toISOString(),hash);return true}
 saveDevice(id:string,name:string,refreshHash:string,persistent=false){const now=new Date().toISOString();this.db.prepare('INSERT INTO devices(id,name,refresh_hash,created_at,last_seen_at,revoked_at,persistent) VALUES(?,?,?,?,?,NULL,?)').run(id,name,refreshHash,now,now,persistent?1:0)}
 getPairPasswordHash(){return (this.db.prepare("SELECT value FROM metadata WHERE key='pair_password_hash'").get() as {value?:string}|undefined)?.value}
 setPairPasswordHash(stored:string){this.db.prepare("INSERT INTO metadata(key,value) VALUES('pair_password_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(stored)}
 clearPairPasswordHash(){return this.db.prepare("DELETE FROM metadata WHERE key='pair_password_hash'").run().changes>0}
	 device(id:string){return this.db.prepare('SELECT * FROM devices WHERE id=? AND revoked_at IS NULL').get(id) as any}
	 rotateDevice(id:string,hash:string){this.db.prepare('UPDATE devices SET refresh_hash=?,last_seen_at=? WHERE id=?').run(hash,new Date().toISOString(),id)}
	 revokeDevice(id:string){return this.db.prepare('UPDATE devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(new Date().toISOString(),id).changes>0}
	 revokeVolatileDevices(){return this.db.prepare('UPDATE devices SET revoked_at=? WHERE revoked_at IS NULL AND persistent=0').run(new Date().toISOString()).changes}
	 close(){this.db.close()}
}
function rowEvent(r:any):BridgeEvent{return {...JSON.parse(r.payload),seq:r.seq}}
function approvalRow(r:any){const {raw_id,epoch,...rest}=r;return {...rest,payload:JSON.parse(r.payload),raw_id:safeJson(raw_id),epoch:Number(epoch??0)}}
function safeJson(value:unknown){try{return JSON.parse(String(value))}catch{return ''}}
function approvalTableSql(){return `CREATE TABLE IF NOT EXISTS approvals(request_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,turn_id TEXT,item_id TEXT,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,raw_id TEXT NOT NULL DEFAULT '""',epoch INTEGER NOT NULL DEFAULT 0,decision TEXT);`}
