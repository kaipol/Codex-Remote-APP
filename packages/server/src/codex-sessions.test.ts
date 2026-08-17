import { mkdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe,expect,it } from 'vitest';
import { CodexSessionCatalog,cleanConversationText,extractText,inspectRollout,parseUserContent,parseUserInput,readRolloutEvents,readRolloutMessages } from './codex-sessions.js';

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
  it('keeps structured image data out of displayed user text',()=>{
    const parsed=parseUserInput([{type:'input_text',text:'检查这张图片'},{type:'input_image',image_url:'data:image/png;base64,iVBORw0KGgo='}]);
    expect(parsed.content).toBe('检查这张图片');
    expect(parsed.content).not.toContain('base64');
    expect(parsed.references).toEqual([{type:'file',label:'图片 1',url:'data:image/png;base64,iVBORw0KGgo='}]);
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
  it('extracts reasoning summary text without turning image items into text',()=>{
    expect(extractText([
      {type:'summary_text',text:'先检查历史事件'},
      {type:'input_image',image_url:'data:image/png;base64,abc'},
      {type:'reasoning_text',text:'再合并重复项'},
    ])).toBe('先检查历史事件\n再合并重复项');
  });
  it('filters internal Chinese handoff summaries from visible messages',async()=>{
    const sessionsDir=join(tmpdir(),`codex-sessions-${crypto.randomUUID()}`);const path=join(sessionsDir,'rollout-summary.jsonl');
    const line=(timestamp:string,type:string,payload:unknown)=>JSON.stringify({timestamp,type,payload})+'\n';
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,
      line('2026-08-14T00:00:00.000Z','response_item',{type:'message',role:'assistant',content:[{type:'output_text',text:'正常回复'}]})+
      line('2026-08-14T00:00:01.000Z','response_item',{type:'message',role:'assistant',content:[{type:'output_text',text:'## 当前进度\n内部交接摘要'}]}));
    try{expect((await readRolloutMessages(path,'thread-1')).map(message=>message.content)).toEqual(['正常回复'])}finally{await rm(sessionsDir,{recursive:true,force:true})}
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
  it('deduplicates a response_item and event_msg user message whose turn_id is nested or on task_started',async()=>{
    const sessionsDir=join(tmpdir(),`codex-sessions-${crypto.randomUUID()}`);const path=join(sessionsDir,'rollout-nested.jsonl');
    const line=(timestamp:string,type:string,payload:unknown)=>JSON.stringify({timestamp,type,payload})+'\n';
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,
      line('2026-08-14T00:00:00.000Z','event_msg',{type:'task_started',turn_id:'turn-a'})+
      line('2026-08-14T00:00:00.500Z','response_item',{type:'message',id:'msg-1',role:'user',content:[{type:'input_text',text:'reply OK'}],internal_chat_message_metadata_passthrough:{turn_id:'turn-a'}})+
      line('2026-08-14T00:00:01.000Z','event_msg',{type:'user_message',client_id:'client-1',message:'reply OK'})+
      line('2026-08-14T00:00:01.500Z','event_msg',{type:'task_complete',turn_id:'turn-a'}));
    try{const messages=await readRolloutMessages(path,'thread-1');expect(messages.map(message=>message.content)).toEqual(['reply OK'])}finally{await rm(sessionsDir,{recursive:true,force:true})}
  });
  it('deduplicates assistant event_msg/response_item pairs within the active turn',async()=>{
    const sessionsDir=join(tmpdir(),`codex-sessions-${crypto.randomUUID()}`);const path=join(sessionsDir,'rollout-assistant.jsonl');
    const line=(timestamp:string,type:string,payload:unknown)=>JSON.stringify({timestamp,type,payload})+'\n';
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,
      line('2026-08-14T00:00:00.000Z','event_msg',{type:'task_started',turn_id:'turn-a'})+
      line('2026-08-14T00:00:01.000Z','event_msg',{type:'agent_message',message:'same assistant text'})+
      line('2026-08-14T00:00:01.500Z','response_item',{type:'message',id:'msg-1',role:'assistant',content:[{type:'output_text',text:'same assistant text'}],internal_chat_message_metadata_passthrough:{turn_id:'internal-turn'}}));
    try{const messages=await readRolloutMessages(path,'thread-1');expect(messages.map(message=>message.content)).toEqual(['same assistant text'])}finally{await rm(sessionsDir,{recursive:true,force:true})}
  });
  it('deduplicates the real image prompt representations and preserves message identity',async()=>{
    const sessionsDir=join(tmpdir(),`codex-sessions-${crypto.randomUUID()}`);const path=join(sessionsDir,'rollout-image.jsonl');
    const line=(timestamp:string,type:string,payload:unknown)=>JSON.stringify({timestamp,type,payload})+'\n';
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,
      line('2026-08-16T00:00:00.000Z','event_msg',{type:'task_started',turn_id:'turn-a'})+
      line('2026-08-16T00:00:00.500Z','response_item',{type:'message',id:'msg-1',role:'user',content:[{type:'input_text',text:'检查图片'},{type:'input_image',image_url:'data:image/png;base64,iVBORw0KGgo='}]})+
      line('2026-08-16T00:00:01.000Z','event_msg',{type:'user_message',client_id:'client-1',message:'检查图片',images:['data:image/png;base64,iVBORw0KGgo=']}));
    try{
      const messages=await readRolloutMessages(path,'thread-1');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({msg_id:'msg-1',client_id:'client-1',turn_id:'turn-a',content:'检查图片'});
      expect(messages[0].references).toEqual([{type:'file',label:'图片 1',url:'data:image/png;base64,iVBORw0KGgo='}]);
    }finally{await rm(sessionsDir,{recursive:true,force:true})}
  });
  it('reports unique user and total message counts without counting paired representations twice',async()=>{
    const sessionsDir=join(tmpdir(),`codex-sessions-${crypto.randomUUID()}`);const path=join(sessionsDir,'rollout-counts.jsonl');
    const line=(timestamp:string,type:string,payload:unknown)=>JSON.stringify({timestamp,type,payload})+'\n';
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,
      line('2026-08-14T00:00:00.000Z','session_meta',{id:'thread-count',cwd:'C:\\workspace',timestamp:'2026-08-14T00:00:00.000Z'})+
      line('2026-08-14T00:00:00.500Z','event_msg',{type:'task_started',turn_id:'turn-a'})+
      line('2026-08-14T00:00:01.000Z','event_msg',{type:'user_message',message:'one'})+
      line('2026-08-14T00:00:01.500Z','response_item',{type:'message',id:'msg-1',role:'user',content:[{type:'input_text',text:'one'}],internal_chat_message_metadata_passthrough:{turn_id:'turn-a'}})+
      line('2026-08-14T00:00:02.000Z','event_msg',{type:'agent_message',message:'reply'})+
      line('2026-08-14T00:00:02.500Z','response_item',{type:'message',id:'msg-2',role:'assistant',content:[{type:'output_text',text:'reply'}],internal_chat_message_metadata_passthrough:{turn_id:'turn-a'}}));
    try{
      const session=await inspectRollout(path);
      expect(session?.user_message_count).toBe(1);
      expect(session?.message_count).toBe(2);
    }finally{await rm(sessionsDir,{recursive:true,force:true})}
  });
  it('keeps user and assistant text from an aborted turn instead of dropping them',async()=>{
    const sessionsDir=join(tmpdir(),`codex-sessions-${crypto.randomUUID()}`);const path=join(sessionsDir,'rollout-aborted.jsonl');
    const line=(timestamp:string,type:string,payload:unknown)=>JSON.stringify({timestamp,type,payload})+'\n';
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,
      line('2026-08-14T00:00:00.000Z','event_msg',{type:'task_started',turn_id:'turn-a'})+
      line('2026-08-14T00:00:00.500Z','event_msg',{type:'user_message',message:'请帮我处理 a'})+
      line('2026-08-14T00:00:01.000Z','event_msg',{type:'agent_message',message:'已开始处理 a'})+
      line('2026-08-14T00:00:02.000Z','event_msg',{type:'turn_aborted',turn_id:'turn-a',reason:'cancelled'}));
    try{
      const messages=await readRolloutMessages(path,'thread-1');
      expect(messages.map(message=>message.content)).toEqual(['请帮我处理 a','已开始处理 a']);
    }finally{await rm(sessionsDir,{recursive:true,force:true})}
  });
  it('keeps custom tool calls and non-empty reasoning while ignoring empty reasoning',async()=>{
    const sessionsDir=join(tmpdir(),`codex-sessions-${crypto.randomUUID()}`);const path=join(sessionsDir,'rollout-events.jsonl');
    const line=(timestamp:string,type:string,payload:unknown)=>JSON.stringify({timestamp,type,payload})+'\n';
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,
      line('2026-08-14T00:00:00.000Z','response_item',{type:'custom_tool_call',id:'custom-1',name:'search_files',call_id:'call-custom',input:{query:'test'}})+
      line('2026-08-14T00:00:00.500Z','response_item',{type:'custom_tool_call_output',call_id:'call-custom',output:'found'})+
      line('2026-08-14T00:00:01.000Z','response_item',{type:'reasoning',id:'reasoning-1',summary:[{type:'summary_text',text:'保留完整思考'}]})+
      line('2026-08-14T00:00:01.500Z','response_item',{type:'reasoning',id:'reasoning-2',summary:[]}));
    try{
      const events=await readRolloutEvents(path,'thread-1');
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({type:'tool_call',content:'found',metadata:{tool:'search_files',status:'completed'}});
      expect(events[1]).toMatchObject({type:'reasoning_status',content:'保留完整思考'});
    }finally{await rm(sessionsDir,{recursive:true,force:true})}
  });
  it('restores historical turn lifecycle and turn identity for tools',async()=>{
    const sessionsDir=join(tmpdir(),`codex-sessions-${crypto.randomUUID()}`);const path=join(sessionsDir,'rollout-lifecycle.jsonl');
    const line=(timestamp:string,type:string,payload:unknown)=>JSON.stringify({timestamp,type,payload})+'\n';
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,
      line('2026-08-14T00:00:00.000Z','event_msg',{type:'task_started',turn_id:'turn-a',started_at:'2026-08-14T00:00:00.000Z'})+
      line('2026-08-14T00:00:01.000Z','response_item',{type:'function_call',id:'call-item',name:'shell_command',call_id:'call-1',arguments:{command:'pwd'}})+
      line('2026-08-14T00:00:02.000Z','event_msg',{type:'task_complete',turn_id:'turn-a',completed_at:'2026-08-14T00:00:02.000Z'}));
    try{
      const events=await readRolloutEvents(path,'thread-1');
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({type:'turn_started',metadata:{turn_id:'turn-a',status:'started'}}),
        expect.objectContaining({type:'turn_completed',metadata:{turn_id:'turn-a',status:'completed'}}),
        expect.objectContaining({type:'tool_call',metadata:expect.objectContaining({turn_id:'turn-a',call_id:'call-1'})}),
      ]));
    }finally{await rm(sessionsDir,{recursive:true,force:true})}
  });
});
