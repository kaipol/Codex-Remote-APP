import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { extname } from 'node:path';
import { createInterface } from 'node:readline';

export interface SpawnSpec {
  command:string;
  args:string[];
}

const WINDOWS_COMMAND_PRIORITY:Record<string,number>={'.exe':0,'.cmd':1,'.bat':2,'.ps1':3};

export function selectWindowsCommand(command:string,candidates:string[]):string {
  if(extname(command))return command;
  const matches=candidates.map(value=>value.trim()).filter(Boolean);
  return matches.sort((left,right)=>(WINDOWS_COMMAND_PRIORITY[extname(left).toLowerCase()]??99)-(WINDOWS_COMMAND_PRIORITY[extname(right).toLowerCase()]??99))[0]??command;
}

function resolveWindowsCommand(command:string):string {
  if(extname(command))return command;
  const result=spawnSync('where.exe',[command],{encoding:'utf8',windowsHide:true});
  if(result.status!==0)return command;
  return selectWindowsCommand(command,result.stdout.split(/\r?\n/));
}

export function createSpawnSpec(command:string,args:string[],platform:NodeJS.Platform=process.platform):SpawnSpec {
  if(platform!=='win32')return {command,args};
  const resolved=resolveWindowsCommand(command);
  switch(extname(resolved).toLowerCase()){
    case '.cmd':
    case '.bat':
      return {command:process.env.ComSpec||'cmd.exe',args:['/d','/s','/c',resolved,...args]};
    case '.ps1':
      return {command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolved,...args]};
    default:
      return {command:resolved,args};
  }
}

export class AppServerProcess extends EventEmitter {
  private child?:ChildProcessWithoutNullStreams;
  constructor(private command:string,private args:string[],private cwd:string){super()}
  get running(){return !!this.child && this.child.exitCode===null}
  start(){
    if(this.running)return;
    const spec=createSpawnSpec(this.command,this.args);
    const child=spawn(spec.command,spec.args,{cwd:this.cwd,shell:false,stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.child=child;
    createInterface({input:child.stdout,crlfDelay:Infinity}).on('line',line=>this.emit('line',line));
    createInterface({input:child.stderr,crlfDelay:Infinity}).on('line',line=>this.emit('stderr',line));
    child.once('error',error=>this.emit('failure',error));
    child.once('exit',(code,signal)=>{this.child=undefined;this.emit('exit',code,signal)});
  }
  write(value:unknown){if(!this.running)throw new Error('Codex app-server is not running');this.child!.stdin.write(`${JSON.stringify(value)}\n`)}
  async stop(graceMs=1500){const child=this.child;if(!child)return;child.stdin.end();await Promise.race([new Promise<void>(r=>child.once('exit',()=>r())),new Promise<void>(r=>setTimeout(r,graceMs))]);if(child.exitCode===null)child.kill();}
}
