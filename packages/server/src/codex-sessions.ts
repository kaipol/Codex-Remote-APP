/*
 * Minimal Codex rollout discovery/reader, adapted from the design of
 * kzahel/yepanywhere (packages/server/src/projects/codex-scanner.ts and
 * packages/server/src/sessions/{codex-discovery,codex-reader}.ts).
 * Upstream commit reviewed: e07ce0967db0948abbcb85a07b35206ee285d434.
 * This is a clean, Codex-only implementation; no multi-provider machinery was copied.
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { basename, extname, join } from 'node:path';
import type { BridgeEvent, Message, MessageReference, Session, SessionDetail } from '@remote/shared';

export interface DiscoveredCodexSession extends Session {
  rollout_path: string;
}

interface Entry { timestamp?: string; type?: string; payload?: Record<string, unknown> }
interface Metadata { id: string; cwd: string; timestamp?: string }
const DELETED_SESSIONS_DIRECTORY = '.codex-session-delete';

export class CodexSessionCatalog {
  private sessions = new Map<string, DiscoveredCodexSession>();
  constructor(readonly sessionsDir: string) {}

  async refresh(): Promise<DiscoveredCodexSession[]> {
    const candidates = preferRepresentations(await findRollouts(this.sessionsDir));
    const parsed = await Promise.all(candidates.map(async path => {
      try { return await inspectRollout(path); } catch { return undefined; }
    }));
    const next = new Map<string, DiscoveredCodexSession>();
    for (const session of parsed) {
      if (!session) continue;
      const previous = next.get(session.session_id);
      if (!previous || session.updated_at > previous.updated_at ||
          (session.updated_at === previous.updated_at && session.rollout_path < previous.rollout_path)) {
        next.set(session.session_id, session);
      }
    }
    this.sessions = next;
    return this.listCached();
  }

  listCached(): DiscoveredCodexSession[] {
    return [...this.sessions.values()].sort(compareSessions);
  }

  async list(): Promise<DiscoveredCodexSession[]> { return this.refresh(); }

  async detail(id: string): Promise<SessionDetail | undefined> {
    let session = this.sessions.get(id);
    if (!session) { await this.refresh(); session = this.sessions.get(id); }
    if (!session) return undefined;
    const [messages,events] = await Promise.all([readRolloutMessages(session.rollout_path, session.session_id),readRolloutEvents(session.rollout_path,session.session_id)]);
    return { ...session, messages, events };
  }
}

export async function inspectRollout(filePath: string): Promise<DiscoveredCodexSession | undefined> {
  const fileStat = await stat(filePath);
  let meta: Metadata | undefined;
  let firstUser = '';
  let latest = 0;
  for await (const line of lines(filePath)) {
    const entry = parseEntry(line);
    if (!entry) continue;
    latest = Math.max(latest, timeValue(entry.timestamp));
    if (!meta && entry.type === 'session_meta') meta = parseMetadata(entry.payload);
    if (!firstUser) {
      const message = messageFromEntry(entry);
      if (message?.role === 'user' && isUsefulUserText(message.content)) firstUser = message.content;
    }
  }
  if (!meta) return undefined;
  const created = validDate(meta.timestamp) ?? validDateFromMs(fileStat.birthtimeMs || fileStat.ctimeMs);
  const updated = validDateFromMs(latest || fileStat.mtimeMs);
  return {
    session_id: meta.id,
    title: titleFrom(firstUser) || `Codex ${basename(filePath).replace(/\.jsonl(?:\.gz|\.zst)?$/i, '')}`,
    status: 'active',
    pinned: false,
    cwd: meta.cwd,
    created_at: created,
    updated_at: updated,
    rollout_path: filePath,
  };
}

export async function readRolloutMessages(filePath: string, sessionId: string): Promise<Message[]> {
  // First pass: collect all entries and identify aborted turn ranges
  const entries: Entry[] = [];
  for await (const line of lines(filePath)) {
    const entry = parseEntry(line);
    if (entry) entries.push(entry);
  }
  // Mark entries belonging to aborted/rolled-back turns.
  // A turn starts at task_started. If turn_aborted or thread_rolled_back occurs,
  // the range extends from the turn start through the next task_started (exclusive)
  // or end of file, to catch trailing token_count/settings events.
  const abortedTurnRanges = new Set<number>();
  let currentTurnStart = -1;
  let abortPending = false;
  for (let i = 0; i < entries.length; i++) {
    const p = entries[i].payload ?? {};
    if (entries[i].type === 'event_msg' && p.type === 'task_started') {
      if (abortPending && currentTurnStart >= 0) {
        for (let j = currentTurnStart; j < i; j++) abortedTurnRanges.add(j);
      }
      currentTurnStart = i;
      abortPending = false;
    } else if (entries[i].type === 'event_msg' && (p.type === 'turn_aborted' || p.type === 'thread_rolled_back')) {
      if (currentTurnStart >= 0) {
        for (let j = currentTurnStart; j <= i; j++) abortedTurnRanges.add(j);
        abortPending = true;
      }
    }
  }
  if (abortPending && currentTurnStart >= 0) {
    for (let j = currentTurnStart; j < entries.length; j++) abortedTurnRanges.add(j);
  }
  // Second pass: build messages, skipping aborted-turn entries.
  // Match representations by stable item IDs first, then by a shared turn ID
  // for the known event_msg/response_item pair. Content and timestamps alone
  // are deliberately not enough: adjacent turns may repeat the same prompt.
  const messages: Message[] = [];
  let seq = 1;
  const msgByKey = new Map<string, { messageIndex:number; entryIndex:number; source:string; timestamp:number; itemId?:string; turnId?:string }>();
  for (let i = 0; i < entries.length; i++) {
    if (abortedTurnRanges.has(i)) continue;
    const entry = entries[i];
    const value = messageFromEntry(entry);
    if (!value || !value.content.trim() && !(value.references?.length) || value.role === 'assistant' && isContextSummary(value.content)) continue;
    const key = `${value.role}\u0000${value.content}`;
    const previous = msgByKey.get(key);
    const timestamp=timeValue(entry.timestamp);
    const sameItem=Boolean(previous?.itemId&&value.itemId&&previous.itemId===value.itemId);
    const sameTurnRepresentation=Boolean(previous?.turnId&&value.turnId&&previous.turnId===value.turnId&&isMessageRepresentationPair(previous.source,entry.type));
    if (previous && (sameItem || sameTurnRepresentation)) {
      const existing = messages[previous.messageIndex];
      const existingHasUrl = existing.references?.some(r => r.url) ?? false;
      const newHasUrl = value.references?.some(r => r.url) ?? false;
      if (newHasUrl && !existingHasUrl) {
        messages[previous.messageIndex] = { ...existing, references: value.references, timestamp: validDate(entry.timestamp) ?? existing.timestamp };
      }
      msgByKey.set(key,{messageIndex:previous.messageIndex,entryIndex:i,source:entry.type??'',timestamp,itemId:value.itemId,turnId:value.turnId});
      continue;
    }
    msgByKey.set(key, {messageIndex:messages.length,entryIndex:i,source:entry.type??'',timestamp,itemId:value.itemId,turnId:value.turnId});
    messages.push({
      msg_id: `${sessionId}:${seq}`,
      session_id: sessionId,
      role: value.role,
      content: value.content,
      ...(value.references?.length ? { references: value.references } : {}),
      timestamp: validDate(entry.timestamp) ?? new Date(0).toISOString(),
      seq: seq++,
    });
  }
  return messages;
}

export async function readRolloutEvents(filePath:string,sessionId:string):Promise<BridgeEvent[]>{
  const events:BridgeEvent[]=[];const calls=new Map<string,BridgeEvent>();let seq=1;
  for await(const line of lines(filePath)){const entry=parseEntry(line);if(!entry||entry.type!=='response_item')continue;const p=entry.payload;if(!p)continue;const type=string(p.type);if(!type)continue;if(type==='message'&&p.role==='assistant'){const content=extractText(p.content??p.message??p.text);if(isContextSummary(content))events.push({id:`${sessionId}:event:${seq}`,session:sessionId,timestamp:validDate(entry.timestamp)??new Date(0).toISOString(),seq:seq++,type:'context_compaction',content,metadata:{item_type:type,item_id:string(p.id)}});continue}if(['message','userMessage','agentMessage'].includes(type))continue;const mapped=historyEvent(type,p);if(!mapped)continue;const callId=string(p.call_id);if(callId&&isToolResult(type)){const existing=calls.get(callId);if(existing){existing.content=extractToolOutput(p.output??p.result??p.error);existing.metadata={...existing.metadata,status:string(p.status)??'completed'};continue}}const event={id:`${sessionId}:event:${seq}`,session:sessionId,timestamp:validDate(entry.timestamp)??new Date(0).toISOString(),seq:seq++,...mapped};events.push(event);if(callId&&isToolCall(type))calls.set(callId,event)}
  return events;
}

async function findRollouts(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async entry => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === DELETED_SESSIONS_DIRECTORY) return;
        return walk(path);
      }
      if (entry.isFile() && /^rollout-.*\.jsonl(?:\.gz|\.zst)?$/i.test(entry.name)) found.push(path);
    }));
  }
  await walk(root);
  return found;
}

function preferRepresentations(paths: string[]): string[] {
  const byBase = new Map<string, string>();
  const rank = (path: string) => path.endsWith('.jsonl') ? 3 : path.endsWith('.gz') ? 2 : 1;
  for (const path of paths.sort()) {
    const base = path.replace(/\.(?:gz|zst)$/i, '');
    const current = byBase.get(base);
    if (!current || rank(path) > rank(current)) byBase.set(base, path);
  }
  return [...byBase.values()];
}

async function* lines(filePath: string): AsyncGenerator<string> {
  if (extname(filePath).toLowerCase() === '.zst') {
    throw new Error('zstd-compressed Codex rollouts are not supported by this minimal build');
  }
  const source = createReadStream(filePath);
  const input = filePath.toLowerCase().endsWith('.gz') ? source.pipe(createGunzip()) : source;
  const reader = createInterface({ input, crlfDelay: Infinity });
  for await (const line of reader) yield line;
}

function parseEntry(line: string): Entry | undefined {
  try {
    const value = JSON.parse(line) as Entry;
    return value && typeof value === 'object' ? value : undefined;
  } catch { return undefined; }
}

function parseMetadata(payload: Record<string, unknown> | undefined): Metadata | undefined {
  if (!payload) return undefined;
  const id = string(payload.id) || string(payload.session_id) || string(payload.thread_id);
  const cwd = string(payload.cwd);
  if (!id || !cwd) return undefined;
  return { id, cwd, timestamp: string(payload.timestamp) };
}

function messageFromEntry(entry: Entry): { role: 'user' | 'assistant'; content: string; references?:MessageReference[]; itemId?:string; turnId?:string } | undefined {
  const payload = entry.payload;
  if (!payload) return undefined;
  const itemId=string(payload.id);
  const turnId=string(payload.turn_id??payload.turnId);
  const withIdentity=(message:{role:'user'|'assistant';content:string;references?:MessageReference[]}|undefined)=>message?{...message,...(itemId?{itemId}:{}),...(turnId?{turnId}:{})}:undefined;
  if (entry.type === 'event_msg') {
    if (payload.type === 'user_message') return withIdentity(textMessage('user', payload.message ?? payload.text ?? payload.content));
    if (payload.type === 'agent_message' || payload.type === 'assistant_message') return withIdentity(textMessage('assistant', payload.message ?? payload.text ?? payload.content));
  }
  if (entry.type === 'response_item' && payload.type === 'message') {
    const role = payload.role === 'user' ? 'user' : payload.role === 'assistant' ? 'assistant' : undefined;
    if (role) return withIdentity(textMessage(role, payload.content ?? payload.message ?? payload.text));
  }
  return undefined;
}

function isMessageRepresentationPair(a:string|undefined,b:string|undefined){return (a==='event_msg'&&b==='response_item')||(a==='response_item'&&b==='event_msg');}

function textMessage(role: 'user' | 'assistant', value: unknown) {
  const raw=extractText(value),parsed=role==='user'?parseUserContent(raw):{content:raw,references:[]};
  const content = cleanConversationText(parsed.content,role).trim();
  return content||parsed.references.length ? { role, content, ...(parsed.references.length?{references:parsed.references}:{}) } : undefined;
}

export function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => {
    const type = string((item as Record<string, unknown>)?.type);
    if (type === 'input_image') {
      const url = string((item as Record<string, unknown>).image_url);
      return url ? '<image_data url="' + url + '">' : '';
    }
    if (!type || ['input_text', 'output_text', 'text'].includes(type)) return extractText(item);
    return '';
  }).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  return extractText(item.text ?? item.input_text ?? item.output_text ?? item.content ?? item.message);
}

export function cleanConversationText(value:string,role:'user'|'assistant'='user'):string{
  if(role==='assistant')return value.replace(/\r\n/g,'\n');
  return value.replace(/\r\n/g,'\n').replace(/\r/g,'\n')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi,'')
    .replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/gi,'')
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi,'')
    .replace(/<app-context>[\s\S]*?<\/app-context>/gi,'')
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gi,'')
    .replace(/<permissions_instructions>[\s\S]*?<\/permissions_instructions>/gi,'')
    .replace(/<collaboration_mode>[\s\S]*?<\/collaboration_mode>/gi,'')
    .replace(/<memory>[\s\S]*?<\/memory>/gi,'')
    .replace(/(?:^|\n)# AGENTS\.md instructions[\s\S]*?(?=\n# (?:Files mentioned|My request|User request)|$)/gi,'\n')
    .replace(/(?:^|\n)# Chrome tabs:[\s\S]*?(?=\n#{1,3}\s|$)/gi,'\n')
    .replace(/(?:^|\n)<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi,'\n')
    .replace(/^\s*#{1,3}\s*(?:My request(?: for Codex)?|User request):\s*/i,'')
    .replace(/\n{3,}/g,'\n\n').trim();
}

export function parseUserContent(value:string):{content:string;references:MessageReference[]}{
  const references:MessageReference[]=[];
  const files=value.match(/(?:^|\n)# Files mentioned by the user:\s*([\s\S]*?)(?=\n#{1,3}\s*(?:My request|User request)|$)/i);
  if(files)for(const match of files[1].matchAll(/(?:^|\n)##\s*([^:\n]+):\s*([^\n]+)/g))references.push({type:'file',label:match[1].trim(),path:match[2].trim()});
  const skill=value.match(/(?:^|\n)#{1,3}\s*My request for Codex:\s*\[\$([^\]\n]+)\]\s*(?:\(([^)]+)\))?/i);
  if(skill)references.push({type:'skill',label:skill[1].trim(),...(skill[2]?{path:skill[2].trim()}:{})});
  // Match <image> tags with either plain or backslash-escaped quotes around path/url values
  for(const match of value.matchAll(/<image\s+name=\[?([^\]\n]+)\]?\s+path=\\?"([^"]+)\\?">[\s\S]*?<\/image>/gi)){
    const path=match[2].trim();
    const label=path.replace(/\\/g,'/').split('/').filter(Boolean).at(-1)||match[1].trim();
    const inner=match[0];
    const dataMatch=inner.match(/<image_data url=\\?"([^"]+)\\?">/i);
    const url=dataMatch?dataMatch[1].trim():undefined;
    references.push({type:'file',label,path,...(url?{url}:{})});
  }
  const annotations=value.match(/<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>/i);
  if(annotations){try{const items=JSON.parse(annotations[1]) as Array<{text?:unknown;comment?:unknown}>;items.forEach((item,index)=>{const detail=String(item.text??'').trim(),comment=String(item.comment??'').trim();references.push({type:'annotation',label:`${index+1} 条注释`,detail:[detail,comment].filter(Boolean).join('\n\n')})})}catch{/* malformed annotation payload */}}
  const content=value
    .replace(/(?:^|\n)# Chrome tabs:[\s\S]*?(?=\n#{1,3}\s|$)/gi,'\n')
    .replace(/(?:^|\n)# Files mentioned by the user:\s*[\s\S]*?(?=\n#{1,3}\s*(?:My request|User request)|$)/i,'\n')
    .replace(/(?:^|\n)#{1,3}\s*My request for Codex:\s*\[\$[^\]\n]+\]\s*(?:\([^)]+\))?\s*/i,'\n')
    .replace(/(?:^|\n)# Response annotations:[\s\S]*?<response-annotations>[\s\S]*?<\/response-annotations>/i,'\n')
    .replace(/<image\s+name=\[?[^\]\n]+\]?\s+path=\\?"[^"]+\\?">[\s\S]*?<\/image>/gi,'\n')
    .replace(/(?:^|\n)#{1,3}\s*(?:My request(?: for Codex)?|User request):\s*/i,'\n')
    .trim();
  const normRefKey = (item: MessageReference) => `${item.type}:${(item.path || item.label || '').replace(/\\/g, '/').toLowerCase()}`;
  const seen = new Map<string, MessageReference>();
  for (const item of references) {
    const key = normRefKey(item);
    const existing = seen.get(key);
    if (!existing) { seen.set(key, item); }
    else if (item.url && !existing.url) { seen.set(key, { ...existing, url: item.url }); }
  }
  return { content, references: [...seen.values()] };
}

function historyEvent(kind:string,p:Record<string,unknown>):Pick<BridgeEvent,'type'|'content'|'metadata'>|undefined{
 const callId=string(p.call_id),base={item_type:kind,item_id:string(p.id)??callId,status:p.status,call_id:callId};
 if(kind==='commandExecution')return {type:'command_execution',content:string(p.aggregatedOutput),metadata:{...base,command:p.command,cwd:p.cwd,exit_code:p.exitCode}};
 if(kind==='fileChange')return {type:'file_change',metadata:{...base,changes:p.changes}};
 if(kind==='reasoning'||kind==='plan'){const content=extractText(p.summary??p.text??p.content);return content.trim()?{type:'reasoning_status',content,metadata:base}:undefined}
 if(kind==='mcpToolCall'||kind==='collabAgentToolCall')return {type:'tool_call',content:extractText(p.result??p.error),metadata:{...base,server:p.server,tool:p.tool,arguments:p.arguments,duration_ms:p.durationMs}};
 if(kind==='webSearch')return {type:'web_search',content:string(p.query),metadata:{...base,action:p.action}};
 if(kind==='function_call'||kind==='custom_tool_call'||kind==='tool_search_call')return {type:'tool_call',metadata:{...base,tool:string(p.name)??(kind==='tool_search_call'?'tool_search':kind),namespace:p.namespace,arguments:parseArguments(p.arguments??p.input),status:string(p.status)??'started'}};
 if(kind==='function_call_output'||kind==='custom_tool_call_output'||kind==='tool_search_output')return {type:'tool_call',content:extractToolOutput(p.output??p.result??p.error),metadata:{...base,tool:string(p.name)??kind.replace(/_output$/,''),status:string(p.status)??'completed'}};
 if(kind==='web_search_call')return {type:'web_search',content:extractText(p.action),metadata:{...base,action:p.action,status:p.status}};
 if(kind==='compaction'||kind==='contextCompaction')return {type:'context_compaction',metadata:base};
 return undefined;
}
function isToolCall(kind:string){return kind==='function_call'||kind==='custom_tool_call'||kind==='tool_search_call'}
function isToolResult(kind:string){return kind==='function_call_output'||kind==='custom_tool_call_output'||kind==='tool_search_output'}
function parseArguments(value:unknown):unknown{if(typeof value!=='string')return value;try{return JSON.parse(value)}catch{return value}}
function extractToolOutput(value:unknown):string{if(typeof value==='string')return stripAnsi(value);if(!value||typeof value!=='object')return '';const r=value as Record<string, unknown>;return stripAnsi(extractText(r.content??r.output??r.text??r))}
function stripAnsi(value:string){return value.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g,'')}

function isUsefulUserText(text: string): boolean {
  const trimmed = text.trim();
  return !!trimmed && !trimmed.startsWith('<environment_context>') && !trimmed.startsWith('# AGENTS.md');
}
function isContextSummary(text:string):boolean{return /^\s*#{1,3}\s*(?:Handoff Summary|Context (?:Summary|Compaction))\b/i.test(text)||/Another language model started to solve this problem/i.test(text)}
function titleFrom(text: string): string { return text.replace(/\s+/g, ' ').trim().slice(0, 120); }
function string(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }
function timeValue(value: unknown): number { const n = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(n) ? n : 0; }
function validDate(value: unknown): string | undefined { const n = timeValue(value); return n ? new Date(n).toISOString() : undefined; }
function validDateFromMs(value: number): string { return new Date(Number.isFinite(value) && value > 0 ? value : 0).toISOString(); }
function compareSessions(a: Session, b: Session): number { return b.pinned === a.pinned ? b.updated_at.localeCompare(a.updated_at) || a.session_id.localeCompare(b.session_id) : Number(b.pinned) - Number(a.pinned); }
