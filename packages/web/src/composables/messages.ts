import type { Message } from '@remote/shared';

export function dedupeMessages(items: Message[]): Message[] {
  const result: Message[] = [];
  for (const item of items) {
    const localId = item.msg_id.startsWith('local:') ? item.msg_id.slice(6) : undefined;
    const index = result.findIndex(existing => {
      const existingLocalId = existing.msg_id.startsWith('local:') ? existing.msg_id.slice(6) : undefined;
      return existing.msg_id === item.msg_id
        || Boolean(existing.client_id && item.client_id && existing.client_id === item.client_id)
        || Boolean(existing.client_id && (existing.client_id === item.msg_id || existing.client_id === localId))
        || Boolean(item.client_id && (item.client_id === existing.msg_id || item.client_id === existingLocalId))
        || Boolean(existingLocalId && (existingLocalId === item.msg_id || existingLocalId === item.client_id))
        || Boolean(localId && (localId === existing.msg_id || localId === existing.client_id))
        // The app-server can replay a completed assistant turn with a new item
        // id. Treat an identical response in the same turn as one message.
        || Boolean(existing.role === 'assistant' && item.role === 'assistant'
          && existing.session_id === item.session_id
          && existing.turn_id && item.turn_id && existing.turn_id === item.turn_id
          && existing.content === item.content);
    });
    if (index < 0) result.push(item);
    else if ((result[index].msg_id.startsWith('local:') || result[index].msg_id.startsWith('stream:'))
      && !item.msg_id.startsWith('local:') && !item.msg_id.startsWith('stream:')) result[index] = item;
  }
  return result.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.seq - b.seq);
}
