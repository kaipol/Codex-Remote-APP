<script setup lang="ts">
import { computed, ref } from 'vue';
import type { BridgeEvent } from '@remote/shared';
import EventCard from './EventCard.vue';
import ReasoningPanel from './ReasoningPanel.vue';

const toolTypes = new Set(['tool_call', 'command_execution', 'web_search', 'file_change']);

const props = defineProps<{
  events?: BridgeEvent[];
}>();
defineEmits<{ openDiff: [diff: string, title: string] }>();

const open = ref(false);

const allEvents = computed(() => props.events ?? []);
const totalCount = computed(() => allEvents.value.length);

function subgroupKind(event: BridgeEvent): 'tool' | 'reasoning' {
  return event.type === 'reasoning_status' ? 'reasoning' : 'tool';
}

interface Subgroup { kind: 'tool' | 'reasoning'; events: BridgeEvent[] }
const subgroups = computed<Subgroup[]>(() => {
  const result: Subgroup[] = [];
  for (const event of allEvents.value) {
    const kind = subgroupKind(event);
    const last = result[result.length - 1];
    if (!last || last.kind !== kind) result.push({ kind, events: [event] });
    else last.events.push(event);
  }
  return result;
});

interface ActivitySummary { label: string; icon: string; detail?: string; }
const activitySummary = computed<ActivitySummary[]>(() => {
  const counts: Record<string, number> = {};
  const detailByType: Record<string, string> = {};
  for (const e of allEvents.value) {
    const key = e.type;
    counts[key] = (counts[key] || 0) + 1;
    if (e.type === 'command_execution' && e.metadata?.command) {
      detailByType[key] = String(e.metadata.command);
    } else if (e.type === 'web_search' && e.metadata?.action) {
      detailByType[key] = String(e.metadata.action);
    } else if (e.type === 'tool_call' && e.metadata?.tool) {
      detailByType[key] = String(e.metadata.tool);
    }
  }
  const parts: ActivitySummary[] = [];
  const typeLabel: Record<string, { label: string; icon: string }> = {
    tool_call: { label: '调用工具', icon: '◇' },
    command_execution: { label: '运行命令', icon: '▶' },
    web_search: { label: '搜索网页', icon: '⌕' },
    file_change: { label: '编辑文件', icon: '±' },
    reasoning_status: { label: '思考', icon: '◎' },
  };
  for (const [type, count] of Object.entries(counts)) {
    const info = typeLabel[type] || { label: type, icon: '·' };
    parts.push({ label: `${info.label} ${count > 1 ? count : ''}`.trim(), icon: info.icon, detail: detailByType[type] });
  }
  return parts;
});

const summaryText = computed(() => activitySummary.value.map(s => s.label).join(' · '));

const isRunning = computed(() => allEvents.value.some(e => {
  const status = String(e.metadata?.status || '');
  return ['inprogress', 'running', 'started'].includes(status.toLowerCase());
}));

const headerLabel = computed(() => {
  if (isRunning.value && activitySummary.value.length) {
    const first = activitySummary.value[0];
    return first.detail ? `正在${first.label}：${first.detail}` : `正在${first.label}`;
  }
  if (activitySummary.value.length) return summaryText.value;
  return `${totalCount.value} 项工具调用`;
});
</script>
<template>
  <div class="tool-call-group" :class="{ 'tool-group-open': open }">
    <button type="button" class="tool-group-header" @click="open = !open">
      <span class="tool-group-icon" aria-hidden="true">
        <svg v-if="isRunning" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" opacity="0.25" />
          <path d="M12 2a10 10 0 0 1 10 10" style="transform-origin: center; animation: reasoning-spin 0.8s linear infinite;" />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2"/>
          <path d="M7 9l3 3-3 3"/>
          <path d="M13 15h4"/>
        </svg>
      </span>
      <span class="tool-chevron" :class="{ 'tool-chevron-open': open }">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 6l6 6-6 6"/>
        </svg>
      </span>
      <span class="tool-group-label">{{ headerLabel }}</span>
    </button>
    <div class="tool-group-body" :class="{ 'tool-group-body-visible': open }">
      <div class="tool-group-inner">
        <template v-for="(sub, si) in subgroups" :key="`sub-${si}`">
          <ReasoningPanel
            v-if="sub.kind === 'reasoning'"
            :events="sub.events"
          />
          <template v-else>
            <EventCard v-for="event in sub.events" :key="event.id" :event="event" @open-diff="(d, t) => $emit('openDiff', d, t)" />
          </template>
        </template>
      </div>
    </div>
  </div>
</template>
