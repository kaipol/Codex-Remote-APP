<script setup lang="ts">
import { computed, ref } from 'vue';
import type { BridgeEvent } from '@remote/shared';

const props = defineProps<{
  events: BridgeEvent[];
}>();

const open = ref(false);

const isThinking = computed(() => {
  if (!props.events.length) return false;
  const last = props.events[props.events.length - 1];
  const phase = String(last.metadata?.phase || '');
  return phase === 'started';
});

const accumulatedText = computed(() =>
  props.events
    .map(e => e.content || '')
    .filter(Boolean)
    .join('')
);

const elapsed = computed(() => {
  if (props.events.length < 2) return undefined;
  const first = new Date(props.events[0].timestamp).getTime();
  const last = new Date(props.events[props.events.length - 1].timestamp).getTime();
  const seconds = Math.round((last - first) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
});

const summary = computed(() => {
  if (isThinking.value) return '正在思考';
  if (elapsed.value) return `已思考 ${elapsed.value}`;
  return '已完成思考';
});

const previewText = computed(() => {
  const text = accumulatedText.value;
  if (!text) return '';
  return text.length > 200 ? text.slice(0, 200) + '…' : text;
});
</script>

<template>
  <div class="reasoning-panel" :class="{ 'reasoning-active': isThinking, 'reasoning-open': open }">
    <button type="button" class="reasoning-header" @click="open = !open">
      <span class="reasoning-icon" aria-hidden="true">
        <svg v-if="isThinking" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" opacity="0.25" />
          <path d="M12 2a10 10 0 0 1 10 10" style="transform-origin: center; animation: reasoning-spin 0.8s linear infinite;" />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 12l2 2 4-4" />
          <circle cx="12" cy="12" r="10" />
        </svg>
      </span>
      <span class="reasoning-label">{{ summary }}</span>
      <span v-if="!isThinking && previewText" class="reasoning-preview">{{ previewText }}</span>
      <span class="reasoning-chevron" :class="{ 'chevron-open': open }">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </span>
    </button>
    <div v-if="open && accumulatedText" class="reasoning-body">
      <div class="reasoning-text">{{ accumulatedText }}</div>
    </div>
  </div>
</template>
