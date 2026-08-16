import { createHash,randomBytes,randomInt,randomUUID,timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import jwt from 'jsonwebtoken';
import type { AuthTokens } from '@remote/shared';
import type { Config } from './config.js';
import type { Store } from './db.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export class AuthService extends EventEmitter{
 constructor(private store:Store,private config:Config){super()}
 createPairCode(){const code=String(randomInt(0,1_000_000)).padStart(6,'0');const expires=new Date(Date.now()+this.config.pairTtl*1000).toISOString();this.store.savePair(hash(code),expires);return {code,expires_at:expires}}
 pair(code:string,name:string):AuthTokens|undefined{if(!this.store.consumePair(hash(code)))return;const id=randomUUID();const refresh=randomBytes(32).toString('base64url');this.store.saveDevice(id,name,hash(refresh));return this.tokens(id,refresh)}
 refresh(deviceId:string,refresh:string):AuthTokens|undefined{const d=this.store.device(deviceId);if(!d)return;const issuedAt=Date.parse(String(d.last_seen_at));const maxAge=this.config.refreshDays*24*60*60*1000;if(!Number.isFinite(issuedAt)||!Number.isFinite(maxAge)||maxAge<=0||issuedAt<=Date.now()-maxAge)return;const a=Buffer.from(d.refresh_hash);const b=Buffer.from(hash(refresh));if(a.length!==b.length||!timingSafeEqual(a,b))return;const next=randomBytes(32).toString('base64url');this.store.rotateDevice(deviceId,hash(next));return this.tokens(deviceId,next)}
	 verify(token:string){const payload=jwt.verify(token,this.config.secret,{issuer:'codex-remote',audience:'codex-remote-web'}) as {sub?:string;type?:string};if(payload.type!=='access'||!payload.sub||!this.store.device(payload.sub))throw new Error('invalid access token');return payload as {sub:string;type:'access'}}
	 revoke(deviceId:string){const revoked=this.store.revokeDevice(deviceId);if(revoked)this.emit('revoked',deviceId);return revoked}
	 invalidateDevicesOnStartup(){return this.store.revokeAllDevices()}
	 private tokens(id:string,refresh:string):AuthTokens{return {device_id:id,refresh_token:refresh,access_token:jwt.sign({type:'access'},this.config.secret,{subject:id,issuer:'codex-remote',audience:'codex-remote-web',expiresIn:this.config.accessTtl}),expires_in:this.config.accessTtl}}
}
