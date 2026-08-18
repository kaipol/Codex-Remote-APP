import { createHash,randomBytes,randomInt,randomUUID,scryptSync,timingSafeEqual,createPrivateKey,createPublicKey,diffieHellman,hkdfSync,createDecipheriv } from 'node:crypto';
import { EventEmitter } from 'node:events';
import jwt from 'jsonwebtoken';
import type { AuthTokens } from '@remote/shared';
import type { Config } from './config.js';
import type { Store } from './db.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export class AuthService extends EventEmitter{
 constructor(private store:Store,private config:Config){super()}
 createPairCode(){const code=String(randomInt(0,1_000_000)).padStart(6,'0');const expires=new Date(Date.now()+this.config.pairTtl*1000).toISOString();this.store.savePair(hash(code),expires);return {code,expires_at:expires}}
 pair(code:string,name:string):AuthTokens|undefined{if(!this.store.consumePair(hash(code)))return;return this.issue(name,false)}
 /** Pair a client by the host-configured pair password. Such devices are persistent: they survive service restarts so the client reconnects automatically once the host is back online. */
 pairByPassword(password:string,name:string):AuthTokens|undefined{const stored=this.store.getPairPasswordHash();if(!stored||!verifyPassword(password,stored))return;return this.issue(name,true)}
 hasPairPassword(){return Boolean(this.store.getPairPasswordHash())}getPairPublicKey(){return this.config.pairEcdhPublicKey}decryptPairBlob(clientPublicKey:Buffer,iv:Buffer,ciphertext:Buffer):string|undefined{try{const serverPriv=createPrivateKey({key:this.config.pairEcdhPrivateKey,format:'der',type:'pkcs8'});const clientPub=createPublicKey({key:clientPublicKey,format:'der',type:'spki'});const shared=diffieHellman({privateKey:serverPriv,publicKey:clientPub});const aesKey=Buffer.from(hkdfSync('sha256',shared,'codex-remote-pair','pair-password-v1',32));const tag=ciphertext.subarray(ciphertext.length-16);const data=ciphertext.subarray(0,ciphertext.length-16);const dec=createDecipheriv('aes-256-gcm',aesKey,iv);dec.setAuthTag(tag);return Buffer.concat([dec.update(data),dec.final()]).toString('utf8')}catch{return undefined}}/** Pair by an ECDH-encrypted password blob: decrypt with the server ECDH key, then verify with scrypt. */pairByEncryptedPassword(clientPublicKey:Buffer,iv:Buffer,ciphertext:Buffer,name:string):AuthTokens|undefined{const password=this.decryptPairBlob(clientPublicKey,iv,ciphertext);if(!password||password.length<8)return;return this.pairByPassword(password,name)}
 /** Sets (or replaces) the pairing password. Loopback-only at the API layer; persisted in SQLite so it survives restarts. */
 setPairPassword(password:string){this.store.setPairPasswordHash(hashPassword(password));this.emit('password-changed')}
 clearPairPassword(){const cleared=this.store.clearPairPasswordHash();if(cleared)this.emit('password-changed');return cleared}
 /** One-time bootstrap: seed the stored password from PAIR_PASSWORD only when nothing is persisted yet, so later runtime/API changes are preserved across restarts. */
 bootstrapPairPassword(){if(this.config.pairPassword&&!this.store.getPairPasswordHash())this.store.setPairPasswordHash(hashPassword(this.config.pairPassword))}
 private issue(name:string,persistent:boolean):AuthTokens{const id=randomUUID();const refresh=randomBytes(32).toString('base64url');this.store.saveDevice(id,name,hash(refresh),persistent);return this.tokens(id,refresh)}
 refresh(deviceId:string,refresh:string):AuthTokens|undefined{const d=this.store.device(deviceId);if(!d)return;const issuedAt=Date.parse(String(d.last_seen_at));const maxAge=this.config.refreshDays*24*60*60*1000;if(!Number.isFinite(issuedAt)||!Number.isFinite(maxAge)||maxAge<=0||issuedAt<=Date.now()-maxAge)return;const a=Buffer.from(d.refresh_hash);const b=Buffer.from(hash(refresh));if(a.length!==b.length||!timingSafeEqual(a,b))return;const next=randomBytes(32).toString('base64url');this.store.rotateDevice(deviceId,hash(next));return this.tokens(deviceId,next)}
	 verify(token:string){const payload=jwt.verify(token,this.config.secret,{issuer:'codex-remote',audience:'codex-remote-web'}) as {sub?:string;type?:string};if(payload.type!=='access'||!payload.sub||!this.store.device(payload.sub))throw new Error('invalid access token');return payload as {sub:string;type:'access'}}
	 revoke(deviceId:string){const revoked=this.store.revokeDevice(deviceId);if(revoked)this.emit('revoked',deviceId);return revoked}
	 invalidateDevicesOnStartup(){return this.store.revokeVolatileDevices()}
	 private tokens(id:string,refresh:string):AuthTokens{return {device_id:id,refresh_token:refresh,access_token:jwt.sign({type:'access'},this.config.secret,{subject:id,issuer:'codex-remote',audience:'codex-remote-web',expiresIn:this.config.accessTtl}),expires_in:this.config.accessTtl}}
}

function hashPassword(password:string){const salt=randomBytes(16);const out=scryptSync(password,salt,64);return salt.toString('hex')+':'+out.toString('hex')}
function verifyPassword(password:string,stored:string){const sep=stored.indexOf(':');if(sep<=0)return false;const salt=Buffer.from(stored.slice(0,sep),'hex');const expected=Buffer.from(stored.slice(sep+1),'hex');if(!salt.length||!expected.length)return false;const computed=scryptSync(password,salt,expected.length);return computed.length===expected.length&&timingSafeEqual(computed,expected)}
