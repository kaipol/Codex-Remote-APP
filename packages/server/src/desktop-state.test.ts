import { mkdir,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe,expect,it } from 'vitest';
import { DesktopStateReader } from './desktop-state.js';

describe('Codex Desktop sidebar registration',()=>{
  it('assigns a remote thread to the matching project and places it first',async()=>{
    const root=join(tmpdir(),`codex-desktop-state-${crypto.randomUUID()}`);
    const projectRoot=join(root,'project');
    await mkdir(projectRoot,{recursive:true});
    const statePath=join(root,'.codex-global-state.json');
    await writeFile(statePath,JSON.stringify({
      'local-projects':{p1:{id:'p1',name:'Project',rootPaths:[projectRoot]}},
      'thread-project-assignments':{old:{projectKind:'local',projectId:'p1'}},
      'sidebar-project-thread-orders':{p1:{threadIds:['old']}},
      'projectless-thread-ids':[],
      'thread-workspace-root-hints':{},
    },null,2));
    try{
      const reader=new DesktopStateReader(root);
      await expect(reader.registerThread('remote-1',projectRoot)).resolves.toBe(true);
      const state=JSON.parse(await readFile(statePath,'utf8'));
      expect(state['thread-project-assignments']['remote-1']).toEqual({projectKind:'local',projectId:'p1'});
      expect(state['sidebar-project-thread-orders'].p1.threadIds).toEqual(['remote-1','old']);
      expect(state['thread-workspace-root-hints']['remote-1']).toBe(projectRoot);
      await expect(reader.registerThread('remote-1',projectRoot)).resolves.toBe(false);
    }finally{await rm(root,{recursive:true,force:true})}
  });
});
