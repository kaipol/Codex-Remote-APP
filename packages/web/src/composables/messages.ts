import type { Message } from '@remote/shared';

export function normalizeMessageContent(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

export function stripNoticeLines(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/^\u26a0\ufe0f?[^\n]*\n?/gim, '');
}

export function sanitizeUserContent(value: string): string {
  return stripNoticeLines(value)
    .replace(/<subagent_notification>[\s\S]*?<\/subagent_notification>/gi, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, '')
    .replace(/<app-context>[\s\S]*?<\/app-context>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function preferExisting(existing: Message, item: Message): boolean {
  // When two copies of the same message are merged, keep the most complete
  // one: a confirmed id over an optimistic/app-server fallback, a client_id
  // that enables edit/resend, and any image/file references.
  if (item.msg_id.startsWith('local:') || item.msg_id.startsWith('stream:')) return true;
  if (existing.msg_id.startsWith('local:') || existing.msg_id.startsWith('stream:')) return false;
  if (!existing.client_id && item.client_id) return false;
  if (!existing.references?.length && item.references?.length) return false;
  return true;
}

export function dedupeMessages(items: Message[]): Message[] {
  const result: Message[] = [];
  const ordered = [...items].map(item => item.role === 'user' ? { ...item, content: sanitizeUserContent(item.content) } : { ...item, content: normalizeMessageContent(item.content) }).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.seq - b.seq);
  for (const item of ordered) {
    if (item.role === 'user' && !item.content && !item.references?.length) continue;
    const localId = item.msg_id.startsWith('local:') ? item.msg_id.slice(6) : undefined;
    const index = result.findIndex(existing => {
      const existingLocalId = existing.msg_id.startsWith('local:') ? existing.msg_id.slice(6) : undefined;
      if (existing.msg_id === item.msg_id) return true;
      if (existing.client_id && item.client_id && existing.client_id === item.client_id) return true;
      if (existing.client_id && (existing.client_id === item.msg_id || existing.client_id === localId)) return true;
      if (item.client_id && (item.client_id === existing.msg_id || item.client_id === existingLocalId)) return true;
      if (existingLocalId && (existingLocalId === item.msg_id || existingLocalId === item.client_id)) return true;
      if (localId && (localId === existing.msg_id || localId === existing.client_id)) return true;
      // Duplicate user submissions: the same message is written to both the
      // rollout (fallback id, maybe no client_id) and the app-server thread
      // (item id + client_id), and edit/resend can repeat an identical message
      // before the first reply arrives. Collapse an identical user message that
      // immediately follows the previous one (same session + content) into it,
      // but keep repeats that are separated by an assistant reply so separately
      // intended requests are not hidden.
      if (existing.role === 'user' && item.role === 'user'
        && existing.session_id === item.session_id
        && normalizeMessageContent(existing.content) === normalizeMessageContent(item.content)
        && result[result.length - 1] === existing) return true;
      // The app-server can replay a completed assistant turn with a new item
      // id. Treat an identical response in the same turn as one message.
      if (existing.role === 'assistant' && item.role === 'assistant'
        && existing.session_id === item.session_id
        && existing.turn_id && item.turn_id && existing.turn_id === item.turn_id
        && normalizeMessageContent(existing.content) === normalizeMessageContent(item.content)) return true;
      return false;
    });
    if (index < 0) result.push(item);
    else if (!preferExisting(result[index], item)) result[index] = item;
  }
  return result.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.seq - b.seq);
}
