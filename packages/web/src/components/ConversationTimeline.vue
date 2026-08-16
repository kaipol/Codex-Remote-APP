<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { BridgeEvent, Message } from '@remote/shared';
import MessageBubble from './MessageBubble.vue';
import ReasoningPanel from './ReasoningPanel.vue';
import CompactionBanner from './CompactionBanner.vue';
import TypingIndicator from './TypingIndicator.vue';
import { dedupeMessages } from '../composables/messages';

const p = defineProps<{
  messages: Message[];
  events: BridgeEvent[];
  loading: boolean;
  pendingStates: Record<string, string>;
  activeTurn: boolean;
  jumpTarget?: { id: string; key: number } | null;
}>();
defineEmits<{ openDiff: [diff: string, title: string]; editPending: [message: Message] }>();
const feed = ref<HTMLElement>();
const jumpOpen = ref(false);
const activeUserIndex = ref<number | null>(null);

/** A segment is either a tool-call group, a reasoning panel, an error banner, or a message bubble, in timeline order. */
type ToolSegment = { kind: 'tools'; group: BridgeEvent[] };
type ToolClusterSegment = { kind: 'tool-cluster'; groups: BridgeEvent[][] };
type ReasoningSegment = { kind: 'reasoning'; events: BridgeEvent[] };
type CompactionSegment = { kind: 'compaction'; event: BridgeEvent };
type ErrorSegment = { kind: 'error'; event: BridgeEvent };
type MessageSegment = { kind: 'message'; message: Message };
type Segment = ToolSegment | ToolClusterSegment | ReasoningSegment | CompactionSegment | ErrorSegment | MessageSegment;

type TurnAssistant = {
  messages: Message[];
  segments: Segment[];
};
type TurnUserItem = { kind: 'user'; message: Message; state?: string };
type TurnAssistantItem = { kind: 'assistant'; assistant: TurnAssistant };
type TurnItem = TurnUserItem | TurnAssistantItem;

const toolTypes = new Set(['tool_call', 'command_execution', 'web_search', 'file_change']);
const hiddenEventTypes = new Set(['assistant_delta', 'assistant_message', 'user_message']);
const noiseEventTypes = new Set(['turn_started', 'turn_completed', 'turn_failed', 'session_updated']);

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
    | { kind: 'reasoning'; time: string; seq: number; data: BridgeEvent }
    | { kind: 'compaction'; time: string; seq: number; data: BridgeEvent }
    | { kind: 'error'; time: string; seq: number; data: BridgeEvent }
    | { kind: 'event'; time: string; seq: number; data: BridgeEvent };

  const toolEvents: BridgeEvent[] = [];
  const standaloneEvents: BridgeEvent[] = [];
  const reasoningEvents: BridgeEvent[] = [];
  const compactionEvents: BridgeEvent[] = [];
  const errorEvents: BridgeEvent[] = [];
  for (const event of visibleEvents) {
    if (event.type === 'reasoning_status') {
      reasoningEvents.push(event);
    } else if (event.type === 'context_compaction') {
      compactionEvents.push(event);
    } else if (event.type === 'provider_error') {
      errorEvents.push(event);
    } else if (toolTypes.has(event.type)) {
      toolEvents.push(event);
    } else {
      standaloneEvents.push(event);
    }
  }

  const raw: RawItem[] = [
    ...visibleMessages.map(d => ({ kind: 'message' as const, time: d.timestamp, seq: d.seq, data: d })),
    ...toolEvents.map(d => ({ kind: 'tool' as const, time: d.timestamp, seq: d.seq, data: d })),
    ...reasoningEvents.map(d => ({ kind: 'reasoning' as const, time: d.timestamp, seq: d.seq, data: d })),
    ...compactionEvents.map(d => ({ kind: 'compaction' as const, time: d.timestamp, seq: d.seq, data: d })),
    ...errorEvents.map(d => ({ kind: 'error' as const, time: d.timestamp, seq: d.seq, data: d })),
    ...standaloneEvents.map(d => ({ kind: 'event' as const, time: d.timestamp, seq: d.seq, data: d })),
  ].sort((a, b) => a.time.localeCompare(b.time) || a.seq - b.seq);

  const result: TurnItem[] = [];
  let cur: TurnAssistant | null = null;
  let pendingTools: BridgeEvent[] = [];
  let pendingReasoning: BridgeEvent[] = [];

  function flushTools() {
    if (!pendingTools.length) return;
    if (!cur) return;
    const groups = groupByType(pendingTools);
    if (groups.length === 1) {
      cur.segments.push({ kind: 'tools', group: groups[0] });
    } else {
      cur.segments.push({ kind: 'tool-cluster', groups });
    }
    pendingTools = [];
  }

  function flushReasoning() {
    if (!pendingReasoning.length) return;
    if (!cur) return;
    cur.segments.push({ kind: 'reasoning', events: pendingReasoning });
    pendingReasoning = [];
  }

  for (const item of raw) {
    if (item.kind === 'reasoning') {
      pendingReasoning.push(item.data);
      continue;
    }
    if (item.kind === 'compaction') {
      if (cur) { flushReasoning(); flushTools(); }
      if (!cur) cur = { messages: [], segments: [] };
      cur.segments.push({ kind: 'compaction', event: item.data });
      continue;
    }
    if (item.kind === 'error') {
      if (cur) { flushReasoning(); flushTools(); }
      if (!cur) cur = { messages: [], segments: [] };
      cur.segments.push({ kind: 'error', event: item.data });
      continue;
    }
    if (item.kind === 'tool') {
      pendingTools.push(item.data);
      continue;
    }
    if (item.kind === 'event') {
      if (cur) {
        flushReasoning();
        flushTools();
        cur.segments.push({ kind: 'tools', group: [item.data] });
      } else {
        pendingTools.push(item.data);
      }
      continue;
    }
    const msg = item.data;
    if (msg.role === 'user') {
      if (cur) { flushReasoning(); flushTools(); result.push({ kind: 'assistant', assistant: cur }); cur = null; }
      pendingTools = [];
      pendingReasoning = [];
      result.push({ kind: 'user', message: msg, state: p.pendingStates[msg.client_id || msg.msg_id] });
    } else {
      if (!cur) cur = { messages: [], segments: [] };
      flushReasoning();
      flushTools();
      cur.messages.push(msg);
      cur.segments.push({ kind: 'message', message: msg });
    }
  }
  if (cur) { flushReasoning(); flushTools(); result.push({ kind: 'assistant', assistant: cur }); }
  return result;
});

const userTurns = computed(() => timeline.value
  .filter((item): item is TurnUserItem => item.kind === 'user')
  .map(item => ({ message: item.message, index: timeline.value.indexOf(item) })));

function userPreview(message: Message) {
  const text = message.content.trim().replace(/\s+/g, ' ');
  if (text) return text.length > 90 ? `${text.slice(0, 90)}…` : text;
  return message.references?.length ? `已添加 ${message.references.length} 个引用` : '空输入';
}

function isLatestUser(item: TurnItem, index: number) {
  if (item.kind !== 'user' || !item.message.content.trim()) return false;
  for (let cursor = timeline.value.length - 1; cursor >= 0; cursor--) {
    const candidate = timeline.value[cursor];
    if (candidate.kind !== 'user' || !candidate.message.content.trim()) continue;
    return cursor === index;
  }
  return false;
}

// Auto-scroll on new timeline items or streaming content updates
let scrollTimer: ReturnType<typeof setTimeout> | null = null;
let suppressAutoScrollUntil = 0;
function autoScroll() {
  if (Date.now() < suppressAutoScrollUntil) return;
  if (scrollTimer) return;
  scrollTimer = setTimeout(() => {
    scrollTimer = null;
    const el = feed.value; if (!el) return;
    // Only auto-scroll if user is near the bottom (within 120px)
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, 60);
}
watch(() => timeline.value.length, autoScroll);
// Also scroll on streaming content changes — use total content length sum
// instead of join(',') which can miss updates when two messages have equal length
watch(() => p.messages.reduce((sum, m) => sum + m.content.length, 0), autoScroll);

function scrollToUserIndex(index: number) {
  activeUserIndex.value = index;
  const wrapper = Array.from(feed.value?.querySelectorAll<HTMLElement>('[data-user-index]') ?? []).find(el => Number(el.dataset.userIndex) === index);
  if (!wrapper) return;
  suppressAutoScrollUntil = Date.now() + 900;
  wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
  window.setTimeout(() => { activeUserIndex.value = null; }, 1200);
}

function scrollToUserMessage(id: string) {
  const wrapper = Array.from(feed.value?.querySelectorAll<HTMLElement>('[data-user-id]') ?? []).find(el => el.getAttribute('data-user-id') === id);
  if (!wrapper) return;
  suppressAutoScrollUntil = Date.now() + 900;
  wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

watch(() => p.jumpTarget, target => {
  if (!target) return;
  nextTick(() => scrollToUserMessage(target.id));
});
</script>
<template>
  <div class="timeline-shell" :class="{ 'jump-open': jumpOpen }">
    <div ref="feed" class="conversation">
      <div v-if="loading" class="timeline-state"><span class="spinner"></span>正在读取会话…</div>
      <div v-else-if="!timeline.length" class="timeline-state empty">
        <img class="empty-mark" src="/icon.svg" alt="">
        <h2>从这里开始</h2>
        <p>向 Codex 描述你的任务。历史和实时事件会保留在此处。</p>
      </div>
      <template v-for="(item, index) in timeline" :key="index">
        <div v-if="item.kind === 'user'" :data-user-index="index" :data-user-id="item.message.msg_id">
          <MessageBubble
            :message="item.message"
            :state="item.state"
            :editable="isLatestUser(item, index)"
            @edit-pending="message => $emit('editPending', message)"
          />
        </div>
        <MessageBubble
          v-else
          :messages="item.assistant.messages"
          :segments="item.assistant.segments"
          @open-diff="(d, t) => $emit('openDiff', d, t)"
        />
      </template>
      <TypingIndicator :active-turn="p.activeTurn" :events="p.events" />
    </div>

    <button v-if="userTurns.length > 1" class="jump-rail-toggle" :class="{ open: jumpOpen }" :title="jumpOpen ? '收起用户输入跳转' : '展开用户输入跳转'" aria-label="用户输入快捷跳转" @click="jumpOpen = !jumpOpen">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16"/><path d="M4 12h10"/><path d="M4 19h16"/><circle cx="18" cy="12" r="2"/></svg>
    </button>
    <aside v-if="jumpOpen && userTurns.length > 1" class="user-jump-rail" aria-label="用户输入快捷跳转">
      <div v-if="userTurns.length" class="user-jump-list">
        <button v-for="(turn, turnNumber) in userTurns" :key="`jump-${turn.index}`" class="user-jump-item" :class="{ active: activeUserIndex === turn.index }" :title="userPreview(turn.message)" :aria-label="`跳转到第 ${turnNumber + 1} 条用户输入`" @click="scrollToUserIndex(turn.index)">
          <span class="user-jump-index">{{ turnNumber + 1 }}</span>
          <span>{{ userPreview(turn.message) }}</span>
        </button>
      </div>
    </aside>
  </div>
</template>
