import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
export interface Config {host:string;port:number;databasePath:string;pairTtl:number;accessTtl:number;refreshDays:number;secret:string;codexHome:string;codexSessionsDir:string;codexCommand:string;codexArgs:string[];codexCwdAllowlist:string[];appServerCwd:string;codexRequestTimeoutMs:number;corsOrigins:string[]}
export function loadConfig(overrides:Partial<Config>={}):Config {
 const codexHome=overrides.codexHome??process.env.CODEX_HOME??join(homedir(),'.codex');
 const rawAllowlist=process.env.CODEX_CWD_ALLOWLIST?.split(process.platform==='win32'?';':':').map(x=>x.trim()).filter(Boolean);
 const allowlist=rawAllowlist&&rawAllowlist.length?rawAllowlist:[process.cwd(),homedir()];
 const args=process.env.CODEX_ARGS?JSON.parse(process.env.CODEX_ARGS):['app-server'];
 const corsOrigins=process.env.CORS_ORIGINS?.split(',').map(x=>x.trim()).filter(Boolean)??['http://localhost:5173','http://127.0.0.1:5173'];
 return {host:process.env.HOST||'0.0.0.0',port:Number(process.env.PORT||8787),databasePath:process.env.DATABASE_PATH||'./data/remote.db',pairTtl:Number(process.env.PAIR_CODE_TTL_SECONDS||300),accessTtl:Number(process.env.ACCESS_TOKEN_TTL_SECONDS||1800),refreshDays:Number(process.env.REFRESH_TOKEN_TTL_DAYS||30),secret:process.env.TOKEN_SECRET||randomBytes(32).toString('hex'),codexHome,codexSessionsDir:process.env.CODEX_SESSIONS_DIR||join(codexHome,'sessions'),codexCommand:process.env.CODEX_COMMAND||'codex',codexArgs:args,codexCwdAllowlist:allowlist,appServerCwd:process.env.CODEX_APP_SERVER_CWD||process.cwd(),codexRequestTimeoutMs:Number(process.env.CODEX_REQUEST_TIMEOUT_MS||30000),corsOrigins,...overrides};
}
