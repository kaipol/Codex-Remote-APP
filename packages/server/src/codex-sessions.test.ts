import { describe,expect,it } from 'vitest';
import { cleanConversationText,parseUserContent } from './codex-sessions.js';

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
});
