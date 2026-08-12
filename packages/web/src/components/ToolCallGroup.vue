<script setup lang="ts">
import { ref } from 'vue';
import type { BridgeEvent } from '@remote/shared';
import EventCard from './EventCard.vue';

defineProps<{ events: BridgeEvent[] }>();
defineEmits<{ openDiff: [diff: string, title: string] }>();

const open = ref(false);
</script>
<template>
  <div class="tool-call-group" :class="{ 'tool-group-open': open }">
    <button type="button" class="tool-group-header" @click="open = !open">
      <span class="tool-group-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
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
      <span class="tool-group-label">{{ events.length }} 项工具调用</span>
      <span class="tool-group-names">{{ events.slice(0, 3).map(e => String(e.metadata?.tool || e.metadata?.command || '工具')).join('、') }}</span>
    </button>
    <div class="tool-group-body" :class="{ 'tool-group-body-visible': open }">
      <div class="tool-group-inner">
        <EventCard v-for="event in events" :key="event.id" :event="event" @open-diff="(d, t) => $emit('openDiff', d, t)" />
      </div>
    </div>
  </div>
</template>
