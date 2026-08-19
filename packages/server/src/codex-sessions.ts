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
  private lastRefreshAt = 0;
  private readonly refreshTtlMs = 5_000;
  private refreshInFlight: Promise<DiscoveredCodexSession[]> | null = null;
  constructor(readonly sessionsDir: string) {}

  async refresh(force = false): Promise<DiscoveredCodexSession[]> {
    if (!force && Date.now() - this.lastRefreshAt < this.refreshTtlMs) {
      return this.listCached();
    }
    if (this.refreshInFlight) return this.refreshInFlight;
    const tracked = this.doRefresh().finally(() => { if (this.refreshInFlight === tracked) this.refreshInFlight = null; });
    this.refreshInFlight = tracked;
    return tracked;
  }

  private async doRefresh(): Promise<DiscoveredCodexSession[]> {
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
    this.lastRefreshAt = Date.now();
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

interface RolloutMessageRecord {
  role: 'user' | 'assistant';
  content: string;
  references?: MessageReference[];
  entryIndex: number;
  itemId?: string;
  turnId?: string;
  clientId?: string;
  source: string;
}

async function readRolloutEntries(filePath: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  for await (const line of lines(filePath)) {
    const entry = parseEntry(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

function abortedRolloutRanges(entries: Entry[]): { skipped: Set<number>; rolledBack: Set<number> } {
  // `skipped` covers every entry in an aborted or rolled-back turn range:
  // non-message entries (reasoning, tool calls, lifecycle markers) in those
  // ranges are skipped so the timeline stays clean.
  // `rolledBack` is the strict subset whose turn was *rolled back* (erased).
  // Messages from those ranges are dropped too, so a duplicate user message
  // that was submitted, then rolled back and retried, never wins client-side
  // dedup and disappears along with the hidden turn. `turn_aborted` only
  // interrupts; its readable user/assistant text is kept.
  const skipped = new Set<number>();
  const rolledBack = new Set<number>();
  let currentTurnStart = -1;
  let abortPending = false;
  let rollbackPending = false;
  for (let i = 0; i < entries.length; i++) {
    const p = entries[i].payload ?? {};
    if (entries[i].type === 'event_msg' && p.type === 'task_started') {
      if (abortPending && currentTurnStart >= 0) {
        for (let j = currentTurnStart; j < i; j++) { skipped.add(j); if (rollbackPending) rolledBack.add(j); }
      }
      currentTurnStart = i;
      abortPending = false;
      rollbackPending = false;
    } else if (entries[i].type === 'event_msg' && (p.type === 'turn_aborted' || p.type === 'thread_rolled_back')) {
      if (currentTurnStart >= 0) {
        for (let j = currentTurnStart; j <= i; j++) { skipped.add(j); if (p.type === 'thread_rolled_back' || rollbackPending) rolledBack.add(j); }
        abortPending = true;
        if (p.type === 'thread_rolled_back') rollbackPending = true;
      }
    }
  }
  if (abortPending && currentTurnStart >= 0) {
    for (let j = currentTurnStart; j < entries.length; j++) { skipped.add(j); if (rollbackPending) rolledBack.add(j); }
  }
  return { skipped, rolledBack };
}

function collectRolloutMessages(entries: Entry[]): RolloutMessageRecord[] {
  const { skipped, rolledBack } = abortedRolloutRanges(entries);
  const records: RolloutMessageRecord[] = [];
  const byKey = new Map<string, number>();
  let currentTurnId: string | undefined;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const payload = entry.payload ?? {};
    if (entry.type === 'event_msg' && payload.type === 'task_started') {
      const startedTurnId = string(payload.turn_id) ?? string(payload.turnId);
      if (startedTurnId) currentTurnId = startedTurnId;
    }
    // A thread rolled back has its work erased. Drop its messages too so a
    // duplicate user message that was submitted, rolled back, then retried
    // never wins client-side dedup and disappears along with the hidden turn.
    if (rolledBack.has(i)) continue;
    // A turn marked aborted (turn_aborted) was interrupted, not erased. Keep
    // its user/assistant text messages so the history stays readable; only
    // skip the non-message entries that belong to the aborted range.
    if (skipped.has(i) && !messageFromEntry(entry)) continue;
    let value = messageFromEntry(entry);
    if (value && currentTurnId) {
      value = { ...value, turnId: currentTurnId };
    }
    if (!value || (!value.content.trim() && !value.references?.length) || (value.role === 'assistant' && isContextSummary(value.content))) continue;
    const key = `${value.role}\u0000${value.content}`;
    const previousIndex = byKey.get(key);
    const previous = previousIndex === undefined ? undefined : records[previousIndex];
    const sameItem = Boolean(previous?.itemId && value.itemId && previous.itemId === value.itemId);
    const sameTurnRepresentation = Boolean(previous?.turnId && value.turnId && previous.turnId === value.turnId && isMessageRepresentationPair(previous.source, entry.type));
    if (previous && previousIndex !== undefined && (sameItem || sameTurnRepresentation)) {
      const existingHasUrl = previous.references?.some(ref => ref.url) ?? false;
      const newHasUrl = value.references?.some(ref => ref.url) ?? false;
      records[previousIndex] = {
        ...previous,
        ...(value.itemId && !previous.itemId ? { itemId: value.itemId } : {}),
        ...(value.turnId && !previous.turnId ? { turnId: value.turnId } : {}),
        ...(value.clientId && !previous.clientId ? { clientId: value.clientId } : {}),
        ...(newHasUrl && !existingHasUrl ? { references: value.references, entryIndex: i } : {}),
      };
      byKey.set(key, previousIndex);
      continue;
    }
    byKey.set(key, records.length);
    records.push({
      role: value.role,
      content: value.content,
      ...(value.references?.length ? { references: value.references } : {}),
      entryIndex: i,
      ...(value.itemId ? { itemId: value.itemId } : {}),
      ...(value.turnId ? { turnId: value.turnId } : {}),
      ...(value.clientId ? { clientId: value.clientId } : {}),
      source: entry.type ?? '',
    });
  }
  return records;
}

export async function inspectRollout(filePath: string): Promise<DiscoveredCodexSession | undefined> {
  const fileStat = await stat(filePath);
  const entries = await readRolloutEntries(filePath);
  let meta: Metadata | undefined;
  let firstUser = '';
  let latest = 0;
  for (const entry of entries) {
    latest = Math.max(latest, timeValue(entry.timestamp));
    if (!meta && entry.type === 'session_meta') meta = parseMetadata(entry.payload);
    if (!firstUser) {
      const message = messageFromEntry(entry);
      if (message?.role === 'user' && isUsefulUserText(message.content)) firstUser = message.content;
    }
  }
  if (!meta) return undefined;
  const records = collectRolloutMessages(entries);
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
    message_count: records.length,
    user_message_count: records.filter(record => record.role === 'user').length,
  };
}

export async function readRolloutMessages(filePath: string, sessionId: string): Promise<Message[]> {
  const entries = await readRolloutEntries(filePath);
  return collectRolloutMessages(entries).map((record, index) => ({
    msg_id: record.itemId ?? `${sessionId}:${index + 1}`,
    ...(record.clientId ? { client_id: record.clientId } : {}),
    ...(record.turnId ? { turn_id: record.turnId } : {}),
    session_id: sessionId,
    role: record.role,
    content: record.content,
    ...(record.references?.length ? { references: record.references } : {}),
    timestamp: validDate(entries[record.entryIndex]?.timestamp) ?? new Date(0).toISOString(),
    // Events use their rollout line number as seq. Messages must use the same
    // coordinate so equal-timestamp entries retain their original position.
    seq: record.entryIndex + 1,
  }));
}

export async function readRolloutEvents(filePath:string,sessionId:string):Promise<BridgeEvent[]> {
  const events:BridgeEvent[] = [];
  const calls = new Map<string, BridgeEvent>();
  let currentTurnId: string | undefined;
  let entryIndex = 0;
  for await (const line of lines(filePath)) {
    const seq = ++entryIndex;
    const entry = parseEntry(line);
    if (!entry) continue;
    const payload = entry.payload;
    if (!payload) continue;
    if (entry.type === 'event_msg') {
      const lifecycle = rolloutLifecycleEvent(payload, sessionId, seq, entry.timestamp);
      const turnId = string(payload.turn_id ?? payload.turnId);
      if (turnId) currentTurnId = turnId;
      if (lifecycle) events.push(lifecycle);
      // thread_rolled_back has no turn_id, but it implicitly fails the
      // current turn. Emit a turn_failed so deriveActiveTurn can settle.
      const msgType = string(payload.type);
      if (msgType === 'thread_rolled_back' && currentTurnId) {
        // A rolled-back turn is erased whether it previously completed or was
        // aborted. Mark/upgrade its lifecycle to rolled_back so the web
        // client's hiddenTurns (ConversationTimeline) hides the turn's
        // duplicate user message, partial reply, and any stray tool activity,
        // and so deriveActiveTurn can settle. Without this, an aborted-then-
        // rolled-back turn would keep status 'interrupted' and leak its events.
        const existingIndex = events.findIndex(e => e.type === 'turn_failed' && e.metadata?.turn_id === currentTurnId);
        if (existingIndex >= 0) {
          events[existingIndex] = { ...events[existingIndex], metadata: { ...events[existingIndex].metadata, turn_id: currentTurnId, status: 'rolled_back' } };
        } else {
          events.push({id:sessionId+':event:'+seq+':rollback',session:sessionId,timestamp:validDate(entry.timestamp)??new Date(0).toISOString(),seq,type:'turn_failed',metadata:{turn_id:currentTurnId,status:'rolled_back'}});
        }
        currentTurnId = undefined;
      }
      continue;
    }
    if (entry.type !== 'response_item') continue;
    const type = string(payload.type);
    if (!type) continue;

    if (type === 'message' && payload.role === 'assistant') {
      const content = extractText(payload.content ?? payload.message ?? payload.text);
      if (isContextSummary(content)) {
        events.push({
          id: `${sessionId}:event:${seq}`,
          session: sessionId,
          timestamp: validDate(entry.timestamp) ?? new Date(0).toISOString(),
          seq,
          type: 'context_compaction',
          content,
          metadata: { item_type: type, item_id: string(payload.id) },
        });
      }
      continue;
    }
    if (['message', 'userMessage', 'agentMessage'].includes(type)) continue;

    const mapped = historyEvent(type, payload);
    if (!mapped) continue;
    const callId = string(payload.call_id);
    if (callId && isToolResult(type)) {
      const existing = calls.get(callId);
      if (existing) {
        existing.content = extractToolOutput(payload.output ?? payload.result ?? payload.error);
        existing.metadata = { ...existing.metadata, status: string(payload.status) ?? 'completed' };
        continue;
      }
    }

    const turnId = string(payload.turn_id ?? payload.turnId) ?? currentTurnId;
    const event: BridgeEvent = {
      id: `${sessionId}:event:${seq}`,
      session: sessionId,
      timestamp: validDate(entry.timestamp) ?? new Date(0).toISOString(),
      seq,
      ...mapped,
      ...(turnId ? { metadata: { ...mapped.metadata, turn_id: turnId } } : {}),
    };
    events.push(event);
    if (callId && isToolCall(type)) calls.set(callId, event);
  }
  return events;
}

function rolloutLifecycleEvent(payload:Record<string, unknown>,sessionId:string,seq:number,entryTimestamp?:string):BridgeEvent|undefined {
  const type=string(payload.type);
  const turnId=string(payload.turn_id ?? payload.turnId);
  if (!type || !turnId) return undefined;
  const fallback = validDate(entryTimestamp) ?? new Date(0).toISOString();
  if (type==='task_started') return {id:sessionId+':event:'+seq,session:sessionId,timestamp:validDate(payload.started_at)??fallback,seq,type:'turn_started',metadata:{turn_id:turnId,status:'started'}};
  if (type==='task_complete') return {id:sessionId+':event:'+seq,session:sessionId,timestamp:validDate(payload.completed_at)??fallback,seq,type:'turn_completed',metadata:{turn_id:turnId,status:'completed'}};
  if (type==='turn_aborted') return {id:sessionId+':event:'+seq,session:sessionId,timestamp:validDate(payload.completed_at)??fallback,seq,type:'turn_failed',metadata:{turn_id:turnId,status:string(payload.reason)??'interrupted'}};
  return undefined;
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

function messageFromEntry(entry: Entry): { role: 'user' | 'assistant'; content: string; references?:MessageReference[]; itemId?:string; turnId?:string; clientId?:string } | undefined {
  const payload = entry.payload;
  if (!payload) return undefined;
  const itemId=string(payload.id);
  const clientId=string(payload.client_id??payload.clientId??payload.clientUserMessageId);
  const passthrough = payload.internal_chat_message_metadata_passthrough as Record<string, unknown> | undefined;
  const turnId=string(payload.turn_id ?? payload.turnId ?? passthrough?.turn_id ?? passthrough?.turnId);
  const withIdentity=(message:{role:'user'|'assistant';content:string;references?:MessageReference[]}|undefined)=>message?{...message,...(itemId?{itemId}:{}),...(turnId?{turnId}:{}),...(clientId?{clientId}:{})}:undefined;
  if (entry.type === 'event_msg') {
    if (payload.type === 'user_message') return withIdentity(textMessage('user', payload.message ?? payload.text ?? payload.content,payload.images));
    if (payload.type === 'agent_message' || payload.type === 'assistant_message') return withIdentity(textMessage('assistant', payload.message ?? payload.text ?? payload.content));
  }
  if (entry.type === 'response_item' && payload.type === 'message') {
    const role = payload.role === 'user' ? 'user' : payload.role === 'assistant' ? 'assistant' : undefined;
    if (role) return withIdentity(textMessage(role, payload.content ?? payload.message ?? payload.text));
  }
  return undefined;
}

function isMessageRepresentationPair(a:string|undefined,b:string|undefined){return (a==='event_msg'&&b==='response_item')||(a==='response_item'&&b==='event_msg');}

function textMessage(role: 'user' | 'assistant', value: unknown,images?:unknown) {
  const raw=extractText(value),parsed=role==='user'?parseUserInput(value,images):{content:raw,references:[]};
  const content = cleanConversationText(parsed.content,role).trim();
  return content||parsed.references.length ? { role, content, ...(parsed.references.length?{references:parsed.references}:{}) } : undefined;
}

export function extractText(value: unknown, depth = 0): string {
  if (depth > 8) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value
    .map(item => extractText(item, depth + 1))
    .filter(Boolean)
    .join('\n');
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  const kind = string(item.type);
  if (kind === 'input_image' || kind === 'image' || kind === 'output_image') return '';
  for (const candidate of [
    item.text,
    item.input_text,
    item.output_text,
    item.summary_text,
    item.reasoning_text,
    item.content,
    item.message,
    item.summary,
    item.value,
  ]) {
    if (candidate === undefined || candidate === value) continue;
    const text = extractText(candidate, depth + 1);
    if (text) return text;
  }
  return '';
}

export function cleanConversationText(value:string,role:'user'|'assistant'='user'):string{
  // Codex Desktop prepends/appends ⚠ notice lines (model-switch, reconnect
  // attempts, backend 502, model-metadata warnings, …) to a message it
  // records. Drop every line that starts with U+26A0 (+ optional U+FE0F) so
  // single and multi-line notices alike are hidden, while a ⚠ that appears
  // mid-body of a real prompt (e.g. "所有包含⚠的警告…") is preserved because
  // it is not at a line start. Authors face the same risk on both sides.
  const stripped = value.replace(/\r\n/g,'\n').replace(/\r/g,'\n')
    .replace(/^\u26a0\ufe0f?[^\n]*\n?/gim,'');
  if(role==='assistant')return stripped;
  return stripped
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi,'')
    .replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/gi,'')
    .replace(/<subagent_notification>[\s\S]*?<\/subagent_notification>/gi,'')
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
  for(const match of value.matchAll(/<image_data\s+url=\\?"([^"]+)\\?">/gi)){
    const url=match[1].trim();
    if(url&&!references.some(reference=>reference.url===url))references.push({type:'file',label:`图片 ${references.filter(reference=>reference.url).length+1}`,url});
  }
  const annotations=value.match(/<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>/i);
  if(annotations){try{const items=JSON.parse(annotations[1]) as Array<{text?:unknown;comment?:unknown}>;items.forEach((item,index)=>{const detail=String(item.text??'').trim(),comment=String(item.comment??'').trim();references.push({type:'annotation',label:`${index+1} 条注释`,detail:[detail,comment].filter(Boolean).join('\n\n')})})}catch{/* malformed annotation payload */}}
  const content=value
    .replace(/(?:^|\n)# Chrome tabs:[\s\S]*?(?=\n#{1,3}\s|$)/gi,'\n')
    .replace(/(?:^|\n)# Files mentioned by the user:\s*[\s\S]*?(?=\n#{1,3}\s*(?:My request|User request)|$)/i,'\n')
    .replace(/(?:^|\n)#{1,3}\s*My request for Codex:\s*\[\$[^\]\n]+\]\s*(?:\([^)]+\))?\s*/i,'\n')
    .replace(/(?:^|\n)# Response annotations:[\s\S]*?<response-annotations>[\s\S]*?<\/response-annotations>/i,'\n')
    .replace(/<image\s+name=\[?[^\]\n]+\]?\s+path=\\?"[^"]+\\?">[\s\S]*?<\/image>/gi,'\n')
    .replace(/<image_data\s+url=\\?"[^"]+\\?">/gi,'\n')
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

export function parseUserInput(value:unknown,images?:unknown):{content:string;references:MessageReference[]}{
  const parsed=parseUserContent(extractText(value));
  const references=[...parsed.references];
  for(const image of imageReferences(value,images))if(!references.some(reference=>reference.url===image.url))references.push(image);
  return {content:parsed.content,references};
}

function imageReferences(...values:unknown[]):MessageReference[]{
  const references:MessageReference[]=[];
  const visit=(value:unknown)=>{
    if(typeof value==='string'){
      if(/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(value))references.push({type:'file',label:`图片 ${references.length+1}`,url:value});
      return;
    }
    if(Array.isArray(value)){for(const item of value)visit(item);return}
    if(!value||typeof value!=='object')return;
    const item=value as Record<string,unknown>;
    const type=string(item.type);
    if(type==='input_image'||type==='image'){
      const url=string(item.image_url??item.url);
      if(url)references.push({type:'file',label:string(item.name)??`图片 ${references.length+1}`,url});
      return;
    }
    visit(item.images);
  };
  for(const value of values)visit(value);
  return references;
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
  return !!trimmed && !/^<subagent_notification>[\s\S]*<\/subagent_notification>$/i.test(trimmed) && !trimmed.startsWith('<environment_context>') && !trimmed.startsWith('# AGENTS.md');
}
function isContextSummary(text:string):boolean{return /^\s*#{0,3}\s*(?:Task Handoff Summary|Handoff Summary|Context (?:Summary|Compaction(?: Summary)?)|当前进度|进度摘要|交接摘要|上下文摘要)(?:\s|$)/i.test(text)||/Another language model started to solve this problem/i.test(text)}
function titleFrom(text: string): string { return text.replace(/\s+/g, ' ').trim().slice(0, 120); }
function string(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }
function timeValue(value: unknown): number { const n = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(n) ? n : 0; }
function validDate(value: unknown): string | undefined { const n = timeValue(value); return n ? new Date(n).toISOString() : undefined; }
function validDateFromMs(value: number): string { return new Date(Number.isFinite(value) && value > 0 ? value : 0).toISOString(); }
function compareSessions(a: Session, b: Session): number { return b.pinned === a.pinned ? b.updated_at.localeCompare(a.updated_at) || a.session_id.localeCompare(b.session_id) : Number(b.pinned) - Number(a.pinned); }
