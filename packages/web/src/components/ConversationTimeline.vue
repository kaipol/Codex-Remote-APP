<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { BridgeEvent, Message } from '@remote/shared';
import MessageBubble from './MessageBubble.vue';
import { dedupeMessages } from '../composables/messages';

const p = defineProps<{
  messages: Message[];
  events: BridgeEvent[];
  loading: boolean;
  pendingStates: Record<string, string>;
}>();
defineEmits<{ openDiff: [diff: string, title: string] }>();
const feed = ref<HTMLElement>();

/** A segment is either a tool-call group or a message bubble, in timeline order. */
type ToolSegment = { kind: 'tools'; group: BridgeEvent[] };
type MessageSegment = { kind: 'message'; message: Message };
type Segment = ToolSegment | MessageSegment;

type TurnAssistant = {
  messages: Message[];
  segments: Segment[];
};
type TurnUserItem = { kind: 'user'; message: Message; state?: string };
type TurnAssistantItem = { kind: 'assistant'; assistant: TurnAssistant };
type TurnItem = TurnUserItem | TurnAssistantItem;

const toolTypes = new Set(['tool_call', 'command_execution', 'web_search', 'file_change']);
const hiddenEventTypes = new Set(['reasoning_status', 'assistant_delta', 'assistant_message', 'user_message']);
const noiseEventTypes = new Set(['turn_started', 'turn_completed', 'turn_failed', 'session_updated', 'context_compaction']);

function groupByType(tools: BridgeEvent[]): BridgeEvent[][] {
  const groups: BridgeEvent[][] = [];
  let prevType = '';
  let grp: BridgeEvent[] = [];
  for (const tool of tools) {
    const tt = String(tool.metadata?.tool || tool.metadata?.command || tool.type);
    if (prevType && tt !== prevType && grp.length) {
      groups.push(grp);
      grp = [];
    }
    grp.push(tool);
    prevType = tt;
  }
  if (grp.length) groups.push(grp);
  return groups;
}

const timeline = computed<TurnItem[]>(() => {
  const hiddenTurns = new Set(
    p.events
      .filter(e => e.type === 'turn_completed' || e.type === 'turn_failed')
      .filter(e => ['interrupted', 'cancelled', 'canceled', 'aborted'].includes(String(e.metadata?.status || '').toLowerCase()))
      .map(e => String(e.metadata?.turn_id || ''))
      .filter(Boolean)
  );
  const visibleMessages = dedupeMessages(p.messages).filter(m => !m.turn_id || !hiddenTurns.has(m.turn_id));
  const visibleEvents = p.events
    .filter(e => !hiddenEventTypes.has(e.type))
    .filter(e => !noiseEventTypes.has(e.type))
    .filter(e => !String(e.metadata?.turn_id || '') || !hiddenTurns.has(String(e.metadata?.turn_id)));

  // Sort everything by timestamp + seq, keeping tools interleaved with messages
  type RawItem =
    | { kind: 'message'; time: string; seq: number; data: Message }
    | { kind: 'tool'; time: string; seq: number; data: BridgeEvent }
    | { kind: 'event'; time: string; seq: number; data: BridgeEvent };

  const toolEvents: BridgeEvent[] = [];
  const standaloneEvents: BridgeEvent[] = [];
  for (const event of visibleEvents) {
    if (toolTypes.has(event.type)) {
      toolEvents.push(event);
    } else {
      standaloneEvents.push(event);
    }
  }

  const raw: RawItem[] = [
    ...visibleMessages.map(d => ({ kind: 'message' as const, time: d.timestamp, seq: d.seq, data: d })),
    ...toolEvents.map(d => ({ kind: 'tool' as const, time: d.timestamp, seq: d.seq, data: d })),
    ...standaloneEvents.map(d => ({ kind: 'event' as const, time: d.timestamp, seq: d.seq, data: d })),
  ].sort((a, b) => a.time.localeCompare(b.time) || a.seq - b.seq);

  const result: TurnItem[] = [];
  let cur: TurnAssistant | null = null;
  let pendingTools: BridgeEvent[] = [];

  // Flush pending tools into the current assistant turn at their timeline position.
  // If no assistant turn exists yet, buffer them for the next one.
  function flushTools() {
    if (!pendingTools.length) return;
    if (!cur) return; // tools before any assistant message: buffer for next turn
    const groups = groupByType(pendingTools);
    for (const group of groups) {
      cur.segments.push({ kind: 'tools', group });
    }
    pendingTools = [];
  }

  for (const item of raw) {
    if (item.kind === 'tool') {
      // Tool events buffer and flush in timeline position before the next message
      pendingTools.push(item.data);
      continue;
    }
    if (item.kind === 'event') {
      // Standalone non-tool events flush current tools then append
      if (cur) {
        flushTools();
        cur.segments.push({ kind: 'tools', group: [item.data] });
      } else {
        pendingTools.push(item.data);
      }
      continue;
    }
    const msg = item.data;
    if (msg.role === 'user') {
      // User message: close any current assistant turn
      if (cur) { flushTools(); result.push({ kind: 'assistant', assistant: cur }); cur = null; }
      // Discard any pending tools that had no assistant turn to attach to
      pendingTools = [];
      result.push({ kind: 'user', message: msg, state: p.pendingStates[msg.client_id || msg.msg_id] });
    } else {
      // Assistant message: flush pending tools BEFORE this message, then add message
      if (!cur) cur = { messages: [], segments: [] };
      flushTools();
      cur.messages.push(msg);
      cur.segments.push({ kind: 'message', message: msg });
    }
  }
  if (cur) { flushTools(); result.push({ kind: 'assistant', assistant: cur }); }
  return result;
});

watch(() => timeline.value.length, async () => {
  await nextTick();
  feed.value?.scrollTo({ top: feed.value.scrollHeight, behavior: 'smooth' });
});
</script>
<template>
  <div ref="feed" class="conversation">
    <div v-if="loading" class="timeline-state"><span class="spinner"></span>正在读取会话…</div>
    <div v-else-if="!timeline.length" class="timeline-state empty">
      <span class="empty-mark">⌁</span>
      <h2>从这里开始</h2>
      <p>向 Codex 描述你的任务。历史和实时事件会保留在此处。</p>
    </div>
    <template v-for="(item, index) in timeline" :key="index">
      <MessageBubble
        v-if="item.kind === 'user'"
        :message="item.message"
        :state="item.state"
      />
      <MessageBubble
        v-else
        :messages="item.assistant.messages"
        :segments="item.assistant.segments"
        @open-diff="(d, t) => $emit('openDiff', d, t)"
      />
    </template>
  </div>
</template>
