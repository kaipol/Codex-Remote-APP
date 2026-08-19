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
  it('removes subagent error notifications from user-visible text',()=>{
    const notification='<subagent_notification>\n{"status":{"errored":"unexpected status 503"}}\n</subagent_notification>';
    expect(cleanConversationText(notification)).toBe('');
    expect(cleanConversationText(notification+'\n\n继续处理')).toBe('继续处理');
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

  it('strips the model-switch warning prefix and keeps the real user request',async()=>{
    const sessionsDir=join(tmpdir(),'codex-sessions-'+crypto.randomUUID());const path=join(sessionsDir,'rollout-modelwarn.jsonl');
    const entry=(timestamp:string,type:string,payload:unknown)=>({timestamp,type,payload});
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,[entry('2026-08-19T00:00:00.000Z','session_meta',{id:'thread-warn',cwd:'C:/workspace',timestamp:'2026-08-19T00:00:00.000Z'}),entry('2026-08-19T00:00:01.000Z','event_msg',{type:'user_message',message:'\u26a0This session was recorded with model `gpt-5.6-terra` but is resuming with `deepseek/deepseek-v4-pro`. Consider switching back to `gpt-5.6-terra` as it may affect Codex performance.\n'}),entry('2026-08-19T00:00:02.000Z','event_msg',{type:'user_message',message:'\u26a0This session was recorded with model `gpt-5.6-terra` but is resuming with `deepseek/deepseek-v4-pro`. Consider switching back to `gpt-5.6-terra` as it may affect Codex performance.\n现在在ai输出的开头或者结尾会出现这种警告，请不要显示'})].map(e=>JSON.stringify(e)).join(String.fromCharCode(10)));
    try{
      const messages=await readRolloutMessages(path,'thread-warn');
      expect(messages.map(message=>message.content)).toEqual(['现在在ai输出的开头或者结尾会出现这种警告，请不要显示']);
    }finally{await rm(sessionsDir,{recursive:true,force:true})}
  });
  it('strips multi-line reconnect and backend warning notices',async()=>{
    const sessionsDir=join(tmpdir(),'codex-sessions-'+crypto.randomUUID());const path=join(sessionsDir,'rollout-reconnect.jsonl');
    const nl=String.fromCharCode(10);
    const entry=(timestamp:string,type:string,payload:unknown)=>({timestamp,type,payload});
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,[entry('2026-08-19T00:00:00.000Z','session_meta',{id:'thread-rc',cwd:'C:/workspace',timestamp:'2026-08-19T00:00:00.000Z'}),entry('2026-08-19T00:00:01.000Z','event_msg',{type:'user_message',message:['\u26a0Reconnecting... 1/5','\u26a0Reconnecting... 2/5','\u26a0unexpected status 502 Bad Gateway: Unknown error, url: http://127.0.0.1:57321/v1/responses','\u26a0Model metadata for `z-ai/glm-5.2` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.'].join(nl)}),entry('2026-08-19T00:00:02.000Z','response_item',{type:'message',role:'assistant',content:[{type:'output_text',text:['\u26a0Model metadata for `z-ai/glm-5.2` not found before my reply.','这是真实回复内容，包含\u26a0以校验保留。'].join(nl)}]})].map(e=>JSON.stringify(e)).join(nl));
    try{
      const messages=await readRolloutMessages(path,'thread-rc');
      expect(messages.filter(m=>m.role==='user').map(m=>m.content)).toEqual([]);
      const assistant=messages.find(m=>m.role==='assistant');
      expect(assistant?.content.trim()).toBe('这是真实回复内容，包含\u26a0以校验保留。');
    }finally{await rm(sessionsDir,{recursive:true,force:true})}
  });
describe('Codex session discovery',()=>{
  it('caches the rollout scan within the TTL window to avoid rescanning on every call',async()=>{
    const sessionsDir=join(tmpdir(),`codex-sessions-${crypto.randomUUID()}`);
    const path=join(sessionsDir,'rollout-cache.jsonl');
    const rollout=(id:string)=>JSON.stringify({timestamp:'2026-08-14T00:00:00.000Z',type:'session_meta',payload:{id,cwd:'C:\\\\workspace',timestamp:'2026-08-14T00:00:00.000Z'}});
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,rollout('cache-session'));
    try{
      const catalog=new CodexSessionCatalog(sessionsDir);
      await catalog.refresh();
      // Delete the rollout — a forced refresh would no longer find it, but
      // a TTL-cached refresh() returns the stale entry without touching disk.
      await rm(path,{force:true});
      const sessions=await catalog.refresh();
      expect(sessions.map(s=>s.session_id)).toEqual(['cache-session']);
      // force=true bypasses the cache and actually rescans the directory.
      const forced=await catalog.refresh(true);
      expect(forced.map(s=>s.session_id)).toEqual([]);
    }finally{await rm(sessionsDir,{recursive:true,force:true})}
  });
  it('deduplicates concurrent refresh calls into a single disk scan',async()=>{
    const sessionsDir=join(tmpdir(),`codex-sessions-${crypto.randomUUID()}`);
    const path=join(sessionsDir,'rollout-dedup.jsonl');
    const rollout=(id:string)=>JSON.stringify({timestamp:'2026-08-14T00:00:00.000Z',type:'session_meta',payload:{id,cwd:'C:\\\\workspace',timestamp:'2026-08-14T00:00:00.000Z'}});
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,rollout('dedup-session'));
    try{
      const catalog=new CodexSessionCatalog(sessionsDir);
      const [a,b,c]=await Promise.all([catalog.refresh(),catalog.refresh(),catalog.refresh()]);
      // All three calls receive the same result — only one disk scan happened.
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(a.map(s=>s.session_id)).toEqual(['dedup-session']);
    }finally{await rm(sessionsDir,{recursive:true,force:true})}
  });
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
  it('does not expose a response_item subagent error as a user message',async()=>{
    const sessionsDir=join(tmpdir(),`codex-sessions-${crypto.randomUUID()}`);const path=join(sessionsDir,'rollout-subagent-error.jsonl');
    const line=(timestamp:string,type:string,payload:unknown)=>JSON.stringify({timestamp,type,payload})+'\n';
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,
      line('2026-08-14T00:00:00.000Z','response_item',{type:'message',role:'user',content:[{type:'input_text',text:'<subagent_notification>\n{"status":{"errored":"unexpected status 503"}}\n</subagent_notification>'}]})+
      line('2026-08-14T00:00:01.000Z','response_item',{type:'message',role:'user',content:[{type:'input_text',text:'真实用户请求'}]}));
    try{expect((await readRolloutMessages(path,'thread-1')).map(message=>message.content)).toEqual(['真实用户请求'])}finally{await rm(sessionsDir,{recursive:true,force:true})}
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
  it('uses rollout line numbers as the shared message and event position',async()=>{
    const sessionsDir=join(tmpdir(),'codex-sessions-'+crypto.randomUUID());const path=join(sessionsDir,'rollout-order.jsonl');
    const line=(type:string,payload:unknown)=>JSON.stringify({timestamp:'2026-08-14T00:00:00.000Z',type,payload})+'\n';
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,
      line('event_msg',{type:'task_started',turn_id:'turn-a'})+
      line('response_item',{type:'message',id:'user-1',role:'user',content:[{type:'input_text',text:'prompt'}]})+
      line('response_item',{type:'reasoning',id:'reasoning-1',summary:[{type:'summary_text',text:'thinking'}]})+
      line('response_item',{type:'mcpToolCall',id:'tool-1',tool:'read',status:'completed'})+
      line('response_item',{type:'message',id:'answer-1',role:'assistant',content:[{type:'output_text',text:'answer'}]}));
    try{
      const [messages,events]=await Promise.all([readRolloutMessages(path,'thread-1'),readRolloutEvents(path,'thread-1')]);
      expect([...messages.map(message=>[message.seq,message.role]),...events.filter(event=>event.type==='reasoning_status'||event.type==='tool_call').map(event=>[event.seq,event.type])].sort((a,b)=>Number(a[0])-Number(b[0]))).toEqual([
        [2,'user'],[3,'reasoning_status'],[4,'tool_call'],[5,'assistant'],
      ]);
    }finally{await rm(sessionsDir,{recursive:true,force:true})}
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
  it('uses rollout entry timestamps when lifecycle payload timestamps are absent',async()=>{
    const sessionsDir=join(tmpdir(),`codex-sessions-${crypto.randomUUID()}`);const path=join(sessionsDir,'rollout-lifecycle-fallback.jsonl');
    const line=(timestamp:string,type:string,payload:unknown)=>JSON.stringify({timestamp,type,payload})+'\n';
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,
      line('2026-08-14T00:00:00.000Z','event_msg',{type:'task_started',turn_id:'turn-a'})+
      line('2026-08-14T00:00:01.000Z','response_item',{type:'reasoning',id:'reasoning-1',summary:[{type:'summary_text',text:'检查'}]})+
      line('2026-08-14T00:00:02.000Z','event_msg',{type:'task_complete',turn_id:'turn-a'}));
    try{
      const events=await readRolloutEvents(path,'thread-1');
      expect(events.map(event=>[event.type,event.timestamp,event.seq])).toEqual([
        ['turn_started','2026-08-14T00:00:00.000Z',1],
        ['reasoning_status','2026-08-14T00:00:01.000Z',2],
        ['turn_completed','2026-08-14T00:00:02.000Z',3],
      ]);
    }finally{await rm(sessionsDir,{recursive:true,force:true})}
  });
  it('filters Task Handoff Summary and Context Compaction Summary from visible messages',async()=>{
    const sessionsDir=join(tmpdir(),'codex-sessions-'+crypto.randomUUID());const path=join(sessionsDir,'rollout-handoff.jsonl');
    const entry=(timestamp:string,type:string,payload:unknown)=>({timestamp,type,payload});
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,[entry('2026-08-19T00:00:00.000Z','session_meta',{id:'thread-handoff',cwd:'C:/workspace',timestamp:'2026-08-19T00:00:00.000Z'}),entry('2026-08-19T00:00:01.000Z','response_item',{type:'message',role:'assistant',content:[{type:'output_text',text:'正常回复'}]}),entry('2026-08-19T00:00:02.000Z','response_item',{type:'message',role:'assistant',content:[{type:'output_text',text:'## Task Handoff Summary 更多任务'}]}),entry('2026-08-19T00:00:03.000Z','response_item',{type:'message',role:'assistant',content:[{type:'output_text',text:'### Context Compaction Summary 摘要'}]})].map(e=>JSON.stringify(e)).join(String.fromCharCode(10)));
    try{
      const messages=await readRolloutMessages(path,'thread-handoff');
      expect(messages.map(message=>message.content)).toEqual(['正常回复']);
      const events=await readRolloutEvents(path,'thread-handoff');
      expect(events.filter(event=>event.type==='context_compaction')).toHaveLength(2);
    }finally{await rm(sessionsDir,{recursive:true,force:true})}
  });
  it('drops a rolled-back turn user message and emits turn_failed(rolled_back)',async()=>{
    const sessionsDir=join(tmpdir(),'codex-sessions-'+crypto.randomUUID());const path=join(sessionsDir,'rollout-rollback.jsonl');
    const entry=(timestamp:string,type:string,payload:unknown)=>({timestamp,type,payload});
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,[entry('2026-08-19T00:00:00.000Z','event_msg',{type:'task_started',turn_id:'turn-a'}),entry('2026-08-19T00:00:00.500Z','event_msg',{type:'user_message',message:'继续'}),entry('2026-08-19T00:00:01.000Z','event_msg',{type:'task_complete',turn_id:'turn-a'}),entry('2026-08-19T00:00:02.000Z','event_msg',{type:'thread_rolled_back'})].map(e=>JSON.stringify(e)).join(String.fromCharCode(10)));
    try{
      const [messages,events]=await Promise.all([readRolloutMessages(path,'thread-1'),readRolloutEvents(path,'thread-1')]);
      expect(messages.map(message=>message.content)).toEqual([]);
      expect(events.filter(event=>event.type==='turn_failed'&&event.metadata?.status==='rolled_back')).toHaveLength(1);
    }finally{await rm(sessionsDir,{recursive:true,force:true})}
  });
  it('keeps an interrupted turn prompt and drops a rolled-back turn duplicate',async()=>{
    const sessionsDir=join(tmpdir(),'codex-sessions-'+crypto.randomUUID());const path=join(sessionsDir,'rollout-rollback-dedup.jsonl');
    const entry=(timestamp:string,type:string,payload:unknown)=>({timestamp,type,payload});
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,[entry('2026-08-19T00:00:00.000Z','event_msg',{type:'task_started',turn_id:'turn-a'}),entry('2026-08-19T00:00:00.500Z','event_msg',{type:'user_message',message:'继续'}),entry('2026-08-19T00:00:01.000Z','event_msg',{type:'turn_aborted',turn_id:'turn-a',reason:'interrupted'}),entry('2026-08-19T00:00:02.000Z','event_msg',{type:'task_started',turn_id:'turn-b'}),entry('2026-08-19T00:00:02.500Z','event_msg',{type:'user_message',message:'继续'}),entry('2026-08-19T00:00:03.000Z','event_msg',{type:'task_complete',turn_id:'turn-b'}),entry('2026-08-19T00:00:04.000Z','event_msg',{type:'thread_rolled_back'})].map(e=>JSON.stringify(e)).join(String.fromCharCode(10)));
    try{
      const messages=await readRolloutMessages(path,'thread-1');
      expect(messages.map(message=>message.content)).toEqual(['继续']);
    }finally{await rm(sessionsDir,{recursive:true,force:true})}
  });
  it('upgrades an aborted-then-rolled-back turn to rolled_back',async()=>{
    const sessionsDir=join(tmpdir(),'codex-sessions-'+crypto.randomUUID());const path=join(sessionsDir,'rollout-aborted-rollback.jsonl');
    const entry=(timestamp:string,type:string,payload:unknown)=>({timestamp,type,payload});
    await mkdir(sessionsDir,{recursive:true});
    await writeFile(path,[entry('2026-08-19T00:00:00.000Z','event_msg',{type:'task_started',turn_id:'turn-a'}),entry('2026-08-19T00:00:00.500Z','event_msg',{type:'user_message',message:'继续'}),entry('2026-08-19T00:00:01.000Z','event_msg',{type:'turn_aborted',turn_id:'turn-a',reason:'interrupted'}),entry('2026-08-19T00:00:02.000Z','event_msg',{type:'thread_rolled_back'})].map(e=>JSON.stringify(e)).join(String.fromCharCode(10)));
    try{
      const [messages,events]=await Promise.all([readRolloutMessages(path,'thread-1'),readRolloutEvents(path,'thread-1')]);
      expect(messages.map(message=>message.content)).toEqual([]);
      const failed=events.filter(event=>event.type==='turn_failed'&&event.metadata?.turn_id==='turn-a');
      expect(failed).toHaveLength(1);
      expect(failed[0].metadata?.status).toBe('rolled_back');
    }finally{await rm(sessionsDir,{recursive:true,force:true})}
  });
});
