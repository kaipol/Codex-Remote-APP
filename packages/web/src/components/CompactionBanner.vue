<script setup lang="ts">
import { computed } from 'vue';
import type { BridgeEvent } from '@remote/shared';

const props = defineProps<{
  event: BridgeEvent;
}>();

const isCompacting = computed(() => {
  const phase = String(props.event.metadata?.phase || '');
  return phase === 'started' || phase === 'inProgress';
});

const label = computed(() => isCompacting.value ? '正在压缩上下文' : '上下文已压缩');
</script>

<template>
  <div class="compaction-banner" :class="{ 'compaction-active': isCompacting }">
    <span class="compaction-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 8v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8" />
        <path d="M3 8l4-4h10l4 4" />
        <path d="M7 12h10" stroke-dasharray="2 2" />
      </svg>
    </span>
    <span class="compaction-label">{{ label }}</span>
  </div>
</template>
