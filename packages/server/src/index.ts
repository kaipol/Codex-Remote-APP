import { createServer } from 'node:http';import { loadConfig } from './config.js';import { Store } from './db.js';import { AuthService } from './auth.js';import { SessionService } from './service.js';import { createApp } from './app.js';import { attachWs } from './ws.js';

export function bootstrap(overrides={}){
  const config=loadConfig(overrides);
  const store=new Store(config.databasePath);
  const auth=new AuthService(store,config);
  // Seed the pair password from PAIR_PASSWORD the first time, so a client that
  // paired with the password can reconnect automatically after a host restart.
  // Only the short-lived one-time-code devices are revoked; password-paired
  // (persistent) devices stay valid, letting reconnects succeed on their own.
  auth.bootstrapPairPassword();
  auth.invalidateDevicesOnStartup();
  const sessions=new SessionService(store,config);
  const server=createServer(createApp(store,auth,sessions,config));
  const ws=attachWs(server,auth,store,config.corsOrigins);
  let publishQueue=Promise.resolve();
  sessions.manager.on('event',event=>{publishQueue=publishQueue.then(async()=>{if(await sessions.canAccessEvent(event))ws.publish(event)}).catch(error=>console.warn('[remote:event] authorization failed',error))});
  sessions.manager.on('capabilities',capabilities=>ws.publishCapabilities(capabilities));
  // Log codex app-server lifecycle events for debugging
  sessions.manager.on('debug',(info:any)=>{console.log('[codex]',info.kind,info.method??'')});
  sessions.manager.rpc.on('stderr',(line:string)=>{
    // The Codex process writes both actual app-server errors and ordinary MCP
    // server log lines to stderr. Logging every MCP message as an error makes
    // successful turns look broken in the console.
    if(line.includes('codex_rmcp_client::logging_client_handler: MCP server log message'))console.debug('[codex:mcp]',line);
    else console.error('[codex:stderr]',line);
  });
  sessions.manager.rpc.on('unavailable',(error:Error)=>{console.error('[codex] app-server unavailable:',error.message)});
  sessions.manager.rpc.on('malformed',(line:string)=>{console.warn('[codex:malformed]',line)});
  void sessions.refresh();
  return {server,store,auth,sessions,config,ws};
}

if(process.env.NODE_ENV!=='test'){
  const x=bootstrap();
  x.server.on('error',(e:NodeJS.ErrnoException)=>{console.error('[server] listen error:',e.message);if(e.code==='EADDRINUSE'){console.error(`[server] port ${x.config.port} already in use. Stop other processes or change PORT in .env`);process.exit(1)}});
  x.server.listen(x.config.port,x.config.host,()=>{
    const pair=x.auth.createPairCode();
    console.log(`Codex Remote: http://localhost:${x.config.port}`);
    if(process.env.CODEX_SUPPRESS_PAIR_LOG!=='1'){
      const yellow='\x1b[1;93m';
      const reset='\x1b[0m';
      console.log(`${yellow}一次性配对码: ${pair.code}${reset} (到期 ${pair.expires_at})`);
      if(x.auth.hasPairPassword())console.log(`${yellow}已配置配对密码${reset}: 远程端可直接用密码配对并跨重启自动重连`);
    }
  });
  // Graceful shutdown
  let shuttingDown=false;
  const shutdown=async(signal:string)=>{if(shuttingDown)return;shuttingDown=true;console.log(`\n[server] ${signal} received, shutting down…`);const force=setTimeout(()=>process.exit(1),5000);force.unref();try{await x.sessions.manager.close()}catch{}x.ws.close();await new Promise<void>(resolve=>x.server.close(()=>resolve()));x.store.close();clearTimeout(force);process.exitCode=0};
  process.on('SIGINT',()=>void shutdown('SIGINT'));
  process.on('SIGTERM',()=>void shutdown('SIGTERM'));
}
