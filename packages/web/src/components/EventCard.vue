<script setup lang="ts">
import { computed, ref } from 'vue';
import type { BridgeEvent } from '@remote/shared';
import DiffCard from './DiffCard.vue';
import MarkdownContent from './MarkdownContent.vue';
import { diffText } from '../composables/diff';
const p = defineProps<{ event: BridgeEvent }>();
defineEmits<{ openDiff: [diff: string, title: string] }>();
const open = ref(false);
const meta = computed(() => p.event.metadata || {});
const diff = computed(() => diffText(meta.value.changes || p.event.content));
const path = computed(() => String((Array.isArray(meta.value.changes) ? (meta.value.changes[0] as any)?.path : meta.value.path) || '文件变更'));
const title = computed(() => {
  if (p.event.type === 'tool_call') return String(meta.value.tool || meta.value.server || '工具调用');
  if (p.event.type === 'command_execution') return String(meta.value.command || '命令执行');
  if (p.event.type === 'web_search') return '网页搜索';
  if (p.event.type === 'file_change') return path.value;
  return p.event.type;
});
const args = computed(() => { const value = meta.value.arguments; if (value == null) return ''; return typeof value === 'string' ? value : JSON.stringify(value, null, 2); });
const hasDetails = computed(() => Boolean(p.event.content?.trim() || args.value));
const statusLabel = computed(() => {
  const status = String(meta.value.status || '');
  if (!status || status === 'completed' || status === 'exec completed' || status === 'succeeded') return '';
  if (status === 'inProgress' || status === 'running') return '运行中';
  if (status === 'failed' || status === 'error') return '失败';
  return status;
});
</script>
<template>
  <DiffCard v-if="event.type === 'file_change'" :diff="diff" :path="path" @open="$emit('openDiff', diff, path)"/>
  <div v-else class="event-card tool">
    <button type="button" class="event-row" :class="{ 'event-row-expanded': open }" :disabled="!hasDetails" @click="open = !open">
      <span class="event-chevron" :class="{ 'event-chevron-open': open, 'event-chevron-hidden': !hasDetails }"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>
      <code class="event-label">{{ title }}</code>
      <span v-if="statusLabel" class="event-status">{{ statusLabel }}</span>
    </button>
    <div v-if="hasDetails" class="event-body" :class="{ 'event-body-visible': open }">
      <div class="event-inner">
        <pre v-if="args" class="event-args">{{ args }}</pre>
        <div v-if="event.content" class="event-result">
          <MarkdownContent :content="event.content"/>
        </div>
      </div>
    </div>
  </div>
</template>
