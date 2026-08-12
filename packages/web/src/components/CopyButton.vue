<script setup lang="ts">
import { ref } from 'vue';
import { copyText } from '../composables/clipboard';
const props = withDefaults(defineProps<{ text: string; label?: string }>(), { label: '复制' });
const copied = ref(false);
async function copy() {
  copied.value = await copyText(props.text);
  if (copied.value) window.setTimeout(() => { copied.value = false; }, 1400);
}
</script>
<template>
  <button type="button" class="copy-button" :aria-label="copied ? '已复制' : label" :title="copied ? '已复制' : label" :disabled="!text" @click="copy">
    <svg v-if="!copied" class="copy-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2"/>
      <path d="M5 15V5a2 2 0 0 1 2-2h10"/>
    </svg>
    <svg v-else class="copy-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20 6L9 17l-5-5"/>
    </svg>
    <small>{{ copied ? '已复制' : label }}</small>
  </button>
</template>
