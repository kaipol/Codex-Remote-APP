import { mkdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe,expect,it } from 'vitest';
import { CodexSessionCatalog,cleanConversationText,parseUserContent,readRolloutMessages } from './codex-sessions.js';

describe('Codex user prompt cleanup',()=>{
  it('extracts file and skill references from injected prompt metadata',()=>{
    const parsed=parseUserContent('# Files mentioned by the user:\n\n## paper.html: D:\\docs\\paper.html\n## My request for Codex:\n[$science] (C:\\skills\\science\\SKILL.md) 请阅读并解释');
    expect(parsed).toEqual({content:'请阅读并解释',references:[{type:'file',label:'paper.html',path:'D:\\docs\\paper.html'},{type:'skill',label:'science',path:'C:\\skills\\science\\SKILL.md'}]});
  });
  it('keeps the first real request after runtime metadata',()=>{
    const source='<environment_context>\n<cwd>C:\\secret</cwd>\n</environment_context>\n## My request for Codex:\n第一句用户输入';
    expect(cleanConversationText(source)).toBe('第一句用户输入');
  });
  it('keeps the request after Chrome tab context',()=>{
    const parsed=parseUserContent('# Chrome tabs:\n- Current URL: https://example.com\n\n## My request for Codex:\n你是什么模型');
    expect(cleanConversationText(parsed.content)).toBe('你是什么模型');
  });
  it('extracts response annotations and image attachments',()=>{
    const parsed=parseUserContent('# Response annotations:\nInstructions\n<response-annotations>\n[{"text":"selected passage"}]\n</response-annotations>\n\n## My request:\n解释这段话\n<image name=[Image #1] path="C:\\attachments\\image.png">\n</image>');
    expect(parsed.content).toBe('解释这段话');
    expect(parsed.references).toEqual([{type:'file',label:'image.png',path:'C:\\attachments\\image.png'},{type:'annotation',label:'1 条注释',detail:'selected passage'}]);
  });
  it('extracts image data URLs from input_image content items',()=>{
    const parsed=parseUserContent('<image name=[Image #1] path="C:\\tmp\\codex-clipboard-abc.png">\n<image_data url="data:image/png;base64,iVBORw0KGgo=">\n</image>');
    expect(parsed.references).toContainEqual({type:'file',label:'codex-clipboard-abc.png',path:'C:\\tmp\\codex-clipboard-abc.png',url:'data:image/png;base64,iVBORw0KGgo='});
  });
  it('strips recommended_plugins and other Codex Desktop injections',()=>{
    const source='<recommended_plugins>\n- Airtable (airtable@openai-curated-remote)\n</recommended_plugins>\n<app-context>\nstuff\n</app-context>\n## My request:\n只保留这段问题';
    expect(cleanConversationText(source)).toBe('只保留这段问题');
  });
  it('normalizes CRLF to LF so response_item and event_msg deduplicate',()=>{
    const crlf='first line\r\nsecond line\r\nthird line';
    const lf='first line\nsecond line\nthird line';
    expect(cleanConversationText(crlf)).toBe(lf);
  });
});

describe('Codex session discovery',()=>{
  it('excludes rollouts kept in .codex-session-delete',async()=>{
    const sessionsDir=join(tmpdir(),`codex-sessions-${crypto.randomUUID()}`);
    const visible=join(sessionsDir,'2026','08','14','rollout-visible.jsonl');
    const deleted=join(sessionsDir,'.codex-session-delete','2026','08','14','rollout-deleted.jsonl');
    const rollout=(id:string)=>JSON.stringify({timestamp:'2026-08-14T00:00:00.000Z',type:'session_meta',payload:{id,cwd:'C:\\workspace',timestamp:'2026-08-14T00:00:00.000Z'}});
    await mkdir(join(sessionsDir,'2026','08','14'),{recursive:true});
    await mkdir(join(sessionsDir,'.codex-session-delete','2026','08','14'),{recursive:true});
    try {
      await Promise.all([writeFile(visible,rollout('visible')),writeFile(deleted,rollout('deleted'))]);
      const sessions=await new CodexSessionCatalog(sessionsDir).list();
      expect(sessions.map(session=>session.session_id)).toEqual(['visible']);
    } finally {
      await rm(sessionsDir,{recursive:true,force:true});
    }
  });
  it('keeps identical messages from different turns while deduplicating paired representations',async()=>{
    const sessionsDir=join(tmpdir(),`codex-sessions-${crypto.randomUUID()}`);const path=join(sessionsDir,'rollout-repeat.jsonl');
    const line=(timestamp:string,type:string,payload:unknown)=>JSON.stringify({timestamp,type,payload})+'\n';
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,line('2026-08-14T00:00:00.000Z','event_msg',{type:'user_message',turn_id:'turn-1',message:'continue'})+line('2026-08-14T00:00:00.500Z','response_item',{type:'message',turn_id:'turn-1',role:'user',content:[{type:'input_text',text:'continue'}]})+line('2026-08-14T00:00:01.000Z','event_msg',{type:'user_message',turn_id:'turn-2',message:'continue'})+line('2026-08-14T00:00:01.500Z','response_item',{type:'message',turn_id:'turn-2',role:'user',content:[{type:'input_text',text:'continue'}]}));
    try{const messages=await readRolloutMessages(path,'thread-1');expect(messages.map(message=>message.content)).toEqual(['continue','continue'])}finally{await rm(sessionsDir,{recursive:true,force:true})}
  });
});
