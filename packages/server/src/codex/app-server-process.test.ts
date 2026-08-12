import { describe,expect,it } from 'vitest';
import { createSpawnSpec,selectWindowsCommand } from './app-server-process.js';

describe('AppServerProcess command resolution',()=>{
  it('prefers a native executable over shell wrappers on Windows',()=>{
    expect(selectWindowsCommand('codex',[
      'D:\\tools\\codex',
      'D:\\tools\\codex.cmd',
      'C:\\Apps\\codex.exe'
    ])).toBe('C:\\Apps\\codex.exe');
  });

  it('keeps executable commands direct',()=>{
    expect(createSpawnSpec('C:\\Apps\\codex.exe',['app-server'],'win32')).toEqual({
      command:'C:\\Apps\\codex.exe',
      args:['app-server']
    });
  });

  it('uses explicit hosts for Windows command and PowerShell scripts',()=>{
    expect(createSpawnSpec('C:\\Apps\\codex.cmd',['app-server'],'win32').args).toEqual(['/d','/s','/c','C:\\Apps\\codex.cmd','app-server']);
    expect(createSpawnSpec('C:\\Apps\\codex.ps1',['app-server'],'win32')).toEqual({
      command:'powershell.exe',
      args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','C:\\Apps\\codex.ps1','app-server']
    });
  });

  it('does not alter non-Windows commands',()=>{
    expect(createSpawnSpec('codex',['app-server'],'linux')).toEqual({command:'codex',args:['app-server']});
  });
});
