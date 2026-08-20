import dotenv from 'dotenv';
import { randomBytes,generateKeyPairSync } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// npm workspace scripts run with cwd=<repo>/packages/<pkg>, so a bare
// `dotenv/config` would look for .env next to the package instead of the repo
// root. Walk up from the current directory to find the nearest .env so the
// configured CODEX_* values (allowlist, app-server cwd, etc.) are applied
// consistently regardless of how the process was launched.
function loadEnv(): void {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
loadEnv();

export interface Config {host:string;port:number;databasePath:string;pairTtl:number;accessTtl:number;refreshDays:number;secret:string;codexHome:string;codexSessionsDir:string;codexCommand:string;codexArgs:string[];codexCwdAllowlist:string[];appServerCwd:string;codexRequestTimeoutMs:number;corsOrigins:string[];allowDangerFullAccess:boolean;pairPassword:string;pairEcdhPrivateKey:Buffer;pairEcdhPublicKey:Buffer}
export function loadConfig(overrides:Partial<Config>={}):Config {
 const codexHome=overrides.codexHome??process.env.CODEX_HOME??join(homedir(),'.codex');
 const configuredDatabasePath=overrides.databasePath??process.env.DATABASE_PATH??'./data/remote.db';
 const databasePath=configuredDatabasePath===':memory:'?':memory:':resolve(configuredDatabasePath);
 const secret=overrides.secret??process.env.TOKEN_SECRET??loadPersistentSecret(databasePath);
 const ecdhKeys=loadPersistentEcdhKeys(databasePath);
 const rawAllowlist=process.env.CODEX_CWD_ALLOWLIST?.split(process.platform==='win32'?';':':').map(x=>x.trim()).filter(Boolean);
 const allowlist=rawAllowlist&&rawAllowlist.length?rawAllowlist:[process.cwd(),homedir()];
 const args=parseCodexArgs(process.env.CODEX_ARGS);
 const corsOrigins=process.env.CORS_ORIGINS?.split(',').map(x=>x.trim()).filter(Boolean)??['http://localhost:5173','http://127.0.0.1:5173','http://localhost','https://localhost','capacitor://localhost'];
 const base:Config={host:process.env.HOST||'0.0.0.0',port:Number(process.env.PORT||8787),databasePath,pairTtl:Number(process.env.PAIR_CODE_TTL_SECONDS||300),accessTtl:Number(process.env.ACCESS_TOKEN_TTL_SECONDS||1800),refreshDays:Number(process.env.REFRESH_TOKEN_TTL_DAYS||30),secret,codexHome,codexSessionsDir:process.env.CODEX_SESSIONS_DIR||join(codexHome,'sessions'),codexCommand:process.env.CODEX_COMMAND||'codex',codexArgs:args,codexCwdAllowlist:allowlist,appServerCwd:process.env.CODEX_APP_SERVER_CWD||process.cwd(),codexRequestTimeoutMs:Number(process.env.CODEX_REQUEST_TIMEOUT_MS||30000),corsOrigins,allowDangerFullAccess:process.env.ALLOW_DANGER_FULL_ACCESS!=='false',pairPassword:overrides.pairPassword??process.env.PAIR_PASSWORD??'',pairEcdhPrivateKey:ecdhKeys.privateKey,pairEcdhPublicKey:ecdhKeys.publicKey};
 return {...base,...overrides,databasePath,secret};
}

function loadPersistentSecret(databasePath:string):string {
 if(databasePath===':memory:')return randomBytes(32).toString('hex');
 const secretPath=process.env.TOKEN_SECRET_FILE?.trim()||join(dirname(databasePath),'.token-secret');
 try {
  const existing=readFileSync(secretPath,'utf8').trim();
  if(existing.length>=32)return existing;
 } catch {/* create on first launch */}
 const value=randomBytes(32).toString('hex');
 try {
  mkdirSync(dirname(secretPath),{recursive:true});
  writeFileSync(secretPath,`${value}\n`,{encoding:'utf8',mode:0o600});
 } catch {
  // If the host refuses persistence, keep the service usable; TOKEN_SECRET
  // should be configured explicitly for deployments where restarts matter.
 }
 return value;
}
function loadPersistentEcdhKeys(databasePath:string):{privateKey:Buffer;publicKey:Buffer}{
 if(databasePath===':memory:')return generateEcdhKeyPair();
 const keyPath=join(dirname(databasePath),'.pair-ecdh-key');
 try{
  const existing=readFileSync(keyPath);
  const privLen=existing.readUInt16BE(0);
  const priv=existing.subarray(2,2+privLen);
  const pub=existing.subarray(2+privLen);
  if(priv.length&&pub.length)return {privateKey:priv,publicKey:pub};
 }catch{/* create on first launch */}
 const keys=generateEcdhKeyPair();
 try{
  mkdirSync(dirname(keyPath),{recursive:true});
  const header=Buffer.alloc(2);
  header.writeUInt16BE(keys.privateKey.length,0);
  writeFileSync(keyPath,Buffer.concat([header,keys.privateKey,keys.publicKey]),{mode:0o600});
 }catch{/* keep usable without persistence */}
 return keys;
}
function generateEcdhKeyPair():{privateKey:Buffer;publicKey:Buffer}{
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
 return {privateKey:Buffer.from(privateKey.export({type:'pkcs8',format:'der'})),publicKey:Buffer.from(publicKey.export({type:'spki',format:'der'}))};
}
function parseCodexArgs(raw:string|undefined):string[]{
 if(!raw)return ['app-server'];
 try{
   const parsed=JSON.parse(raw);
   if(!Array.isArray(parsed)||parsed.some(value=>typeof value!=='string'))throw new Error('must be a JSON string array');
   return parsed;
 }catch(error){
   throw new Error('CODEX_ARGS must be a JSON string array, for example ["app-server"]: '+(error as Error).message);
 }
}
